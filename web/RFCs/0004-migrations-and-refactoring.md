# RFC 0004: Migrations and refactoring

- **Status:** Descriptive + directional (documents current approach, notes the target)
- **Author:** liamzebedee
- **Created:** 2026-07-09
- **Scope:** protodatabase / mealplanner

## Summary

Schema evolution follows the protobuf model: **you never delete data, you add.** The
protobuf field NUMBER is the stable physical identity, which makes renames and reorders
free and makes the `.proto` file itself readable (important fields at the top, retired
ones left as numbering gaps below). Evolution happens in **two tiers**: a runtime
**additive migrator** for structural changes (new table / new column), and hand-written
**one-off scripts** for anything that moves or reshapes data. This RFC documents how that
works today and where it is intended to go.

## The core idea: field numbers are the physical identity

Physical tables are `t<fieldNumber>` and columns are `f<fieldNumber>`
(RFC 0003). Nothing physical is keyed by *name* or by *file order*. Three consequences,
all of which serve the "readable schema, append-only data" goal:

1. **Renames are free.** Renaming a proto field changes the generated name and the
   legibility VIEW, but the `fN` column and its data are untouched. No migration needed
   for a pure rename.
2. **Reordering is free and encouraged.** Because file order is cosmetic and physical
   order is the field number, you can put the **most important fields at the top of the
   message** and push **retired/deprecated fields to the bottom** — the schema reads like
   documentation without any effect on storage.
3. **Deletion is a gap, not a removal.** A retired table/field leaves its number vacant
   rather than renumbering the survivors onto occupied physical slots. Current example
   (`src/proto/models/database.proto:11-14,31-42`): numbers **4, 5, 7, 8 are
   intentionally skipped** — the retired `week`, `log`, `supp_nutrition`,
   `meal_lists_collapsed` tables — while `slot_items` took the next free number (14). The
   header states the rule: *"Physical tables are keyed by field NUMBER; retired tables
   left gaps. Never change a field number or name here without a migration."*

Note the current convention uses **numbering gaps** to retire tables rather than the
protobuf `reserved` keyword — there is no `reserved` and no `deprecated` option anywhere
in the `.proto` today. `reserved <n>;` would be the more self-documenting way to mark a
gap as permanently retired (and to prevent accidental reuse of the number); adopting it
is a low-cost improvement, not a requirement.

## Tier 1 — the runtime additive migrator (structural, automatic)

`Db.migrate()` (`protodatabase/client.ts:235-255`) runs at every startup, invoked in
`src/proto/connection.ts:15-16` (imported for side effect by `main.ts`). For each table
it diffs the proto descriptor against `PRAGMA table_info`:

- table missing → `CREATE TABLE`;
- column missing → `ALTER TABLE … ADD COLUMN`;
- always (re)creates the legibility VIEW.

It is **idempotent with no ledger** — "done" is read straight off the live DB
(`client.ts:233-234`). Old rows get `NULL` in new columns, which is safe precisely
because columns are keyed by field number, so a new field can never collide with old
data. This is the append-only structural path: **adding a table or a nullable column
needs zero migration code** — you edit the `.proto`, regenerate, restart.

What tier 1 deliberately does **not** do (non-goals, `protodatabase/README.md:97-104`):
drop columns/tables, move data between rows/tables, or reshape values. Those are
destructive or cross-row and belong in tier 2.

## Tier 2 — one-off scripts (data moves, reshapes, backfills)

`src/migrations/` holds standalone scripts, run **by hand**
(`bun src/migrations/00X-*.ts`), ordered by filename convention. Current set:

- **`001-relational-owner.ts`** — the big refactor to multi-tenant relational. Seeds user
  Liam (id 1), stamps `owner` on every pre-existing row, folds
  `meal_lists_collapsed`→`mealLists.collapsed` and `supp_nutrition`→`supplements.parsed`,
  **explodes** the per-day `Slots` blobs (old `week`/`log`) into `slot_items` rows, then
  drops the retired tables (t4/t5/t7/t8) and the pre-protodb legacy `kv`/`meals` tables.
- **`002-user-auth.ts`** — reshapes the seeded user from `{id,username,password}` to
  `{id,email,username,password_hash}`, bcrypt-hashing the seed password.
- **`003-seed-anna.ts`** — creates test user Anna, allocating id via `max(id)+1` and
  calling `seedUserContent(id)`.
- **`004-existing-users-onboarded.ts`** — sets `onboarded`/`tour_completed` on
  pre-existing accounts so they skip first-run flows.

**Idempotency is each script's own responsibility, via guard clauses** — e.g. `002`
returns early `if (u.email.includes("@"))`; `001` is idempotent by construction because it
targets tables that no longer exist after the first run. There is deliberately **no way
to delete user data as a migration primitive**; these scripts do destructive *schema*
cut-overs (dropping already-drained retired tables), never destructive data loss on live
entities.

## The "no back-compat, clean cut-over" convention

The project is pre-production and explicitly refuses dual-read back-compat cruft. Change
the schema cleanly, write a one-time script to carry the data across, delete the legacy
path. Evidence in-tree:

- `database.proto:14`: *"Schema changes are handled by scripts in src/migrations/."*
- `protodatabase/README.md:97-104`: cross-row data moves *"stay as one-off backfill
  scripts."*
- `src/proto/legacy_import.ts:7`: *"Delete this module once every DB has been migrated."*
- Each migration header documents a destructive cut-over rather than a compatibility
  shim.

This is consistent with the indexes/relationships RFCs: destructive operations are
allowed on *derived or drained* structure (indexes, emptied retired tables), never on
live ground-truth rows.

## Current gaps and intended direction

The scripts work, but the current state is acknowledged as interim (`LEARNINGS.MD` lists
"standard migration system" as still-wanted). There is today **no runner, no ledger, no
CLI verb** — scripts are run manually and their idempotence is hand-maintained.

The intended target (design agreed in discussion; not yet built):

- **A ledger tier that is separate from tier 1.** Structural `migrate()` stays
  ledger-free (idempotent by DB diff). Data migrations get a small `migrations` table
  where **presence of a row = applied** (id + `ran_at`; no 0/1 flag needed).
- **A runner** that runs tier 1 first (structure), then applies pending tier-2 migrations
  in filename order, **each in a transaction that also writes its ledger row**, so a crash
  can't half-apply.
- **`timestamp_slug.ts` filenames** for deterministic ordering.
- **A CLI verb** — extend `protodatabase/cli.ts` (currently a single-shot generator, no
  subcommands) with `migration:create "<description>"` (writes a stub) and
  `migration:run`.
- **A backfill-only facade** passed into each migration's exported `up(db)` — exposing
  `select`/`insert`/`update` but **not** `delete`, so "no destructive data migration" is
  a type error rather than a review note. (Note: current scripts use raw SQL and the
  typed client freely; the facade is a future guardrail.)
- Ledgering matters most for backfills that are *not* naturally idempotent; where a
  backfill upserts on a PK (including composite PKs on join tables, RFC 0001) it is
  idempotent anyway and the ledger is a safety net rather than a correctness requirement.

Indexes explicitly do **not** flow through tier 2 (RFC 0002): index create/drop is
non-destructive, so it belongs in the declarative-reconciled structural tier, never in
the ledger.

## Worked example — nutrient units string → enum (migration 005)

`ValueUnit.unit` moved from a free `string` (field 1) to the `Unit` enum (field 3) in
`proto/types.proto`. The steps followed the expand-only pattern exactly:

1. Retire field 1 (`reserved 1;`) and add `Unit unit = 3;` — a *new* field number, so old
   blobs' field-1 bytes decode as an ignored unknown field (no wire-type clash), and the
   new field defaults to `UNIT_UNSPECIFIED`.
2. Regenerate; update producers (`profile.ts`) to write the enum and consumers
   (`biz/nutrition.ts` `unitLabel`, frontend) to render it.
3. Backfill script `src/migrations/005-units-enum.ts` re-derives each stored unit from the
   canonical `MICRO_GROUPS` spec (the unit is intrinsic to the nutrient) — idempotent, so
   re-runnable.

No value data was touched or lost; the string field is simply retired as a gap.

## Index operations in the ledger

Per the RFC 0002 decision, index CREATE/DROP is reconciled from the declared config but
**also written to the migrations ledger** with a timestamp — the same ledger the data
migrations use. So the ledger is the single write-log of every schema-affecting op (data
backfills + index ops), while reconciliation keeps the actual index set matching the
declared config.

## The deploy dance (expand-only)

The end-to-end sequence for a schema change is the expand/contract (parallel-change)
pattern — with the contract phase dropped because data is never deleted:

1. Add the field/table to the `.proto` (place it sensibly for readability; number is what
   matters).
2. Regenerate (`bun run gen`) → new DDL/types/client.
3. Startup `migrate()` adds the table/column automatically (tier 1).
4. If there is data to move or reshape, write and run a one-off migration (tier 2).
5. Only then enable the new field in the frontend.

Because nothing is ever deleted, there is no contract phase — which is what makes the
whole sequence safe to run forward without coordination.
