# RFC 0002: Indexes

- **Status:** Draft
- **Author:** liamzebedee (design discussion, captured)
- **Created:** 2026-07-09
- **Scope:** protodatabase / mealplanner

## Summary

Where indexes live: in the **declarative, reconciled** schema tier (alongside tables and
columns), **not** in the imperative ledgered-migration tier. The deciding principle is
that indexes are *derived* — dropping one loses no data — so the append-only constraint
that governs columns simply does not bind them. This lets `migrate()` reconcile indexes
**two-way** (create missing, drop stale), safely.

## Decision

- Indexes are declared **declaratively**, in the schema tier, and **reconciled** by the
  startup migrator.
- Columns reconcile **add-only** (never dropped — destructive). Indexes reconcile
  **two-way** (created and dropped — non-destructive).
- The index spec is a small, closed vocabulary (SQLite has essentially one index type),
  so it is expressible as typed declarative data, not an open-ended DSL.
- Deterministic, namespaced index names (`pdbidx_…`) make drop-reconciliation safe.
- A `UNIQUE` index doubles as the auth identity constraint from RFC 0001 — no separate
  "constraints" concept is needed.

## The deciding principle: indexes are not in the append-only category

The whole reason columns and tables are append-only is that **dropping them loses
data**. That is the entire justification for the ledger, the run-once machinery, all of
it (RFC 0004).

Indexes do not lose data. `CREATE INDEX` and `DROP INDEX` are both completely
non-destructive — an index is *derived* from the rows and holds no ground truth. You can
drop every index in the database and recreate them and lose nothing.

So the constraint that forces "additive only, ledgered, run-once" **does not apply to
indexes at all.** They therefore do not belong in the imperative migration tier. They
belong in the *declarative, reconciled* tier alongside tables and columns — but with a
stronger reconcile than columns get:

- **Columns:** reconcile is add-only (never drop, destructive).
- **Indexes:** reconcile is **two-way** — create the declared-but-missing, *drop* the
  existing-but-no-longer-declared. Safe in both directions because a drop costs nothing.

This directly answers "you might want to delete them": you delete an index by **removing
it from the declaration**, and the next `migrate()` drops it. In an imperative world you
would hand-write a `DROP INDEX` migration and index state would be smeared across
migration history — which is exactly the "explicit code shown at all times" violation we
want to avoid, since to know what indexes exist you would have to replay the log.
Declarative-reconciled keeps the full index set visible in one place. Not a close call:
**declarative, in the schema tier, reconciled two-way.**

## The "many index types" worry is mostly a Postgres concern

The instinct to worry about an open-ended type system (btree, hash, gin, gist, geo…) is
a Postgres concern. **SQLite has essentially one index type: B-tree.** The entire index
surface is:

- columns (one or many → composite)
- `UNIQUE` or not
- per-column `DESC`
- per-column `COLLATE` (this is how you get case-insensitive `username` lookup)
- optional partial `WHERE` clause
- optional expression instead of a bare column

That is the whole vocabulary. There is no "pick your index structure." Geospatial in
SQLite is not an index annotation at all — it is the **R-Tree module**, a separate
virtual table declared explicitly. So it never enters the "what kind of index is this
column" question; it is its own table type, which incidentally suits the explicit-tables
instinct fine.

Because the surface is small and *closed*, a declarative index spec is tractable — not
an extensible type system, just ~five fields:

```ts
// index manifest, typed against the generated Schema — declarative data, not migration steps
{ table: "users",    columns: ["username"],           unique: true, collate: "nocase" }
{ table: "meals",    columns: ["user_id"] }
{ table: "mealTags", columns: ["meal_id", "tag_id"],  unique: true }   // composite
{ table: "sessions", columns: ["expires_at"],         where: "revoked = 0" } // partial
```

Whether that lives as proto field/message options or as a sibling `indexes.ts` typed
against the generated `Schema` — lean to the **TS manifest**: it is declarative (just
data), typed (a renamed column breaks it at build time), colocated, one visible file,
and it dodges protobuf's genuinely clunky custom-options syntax. It is DDL in spirit,
just not expressed in the `.proto`.

## Naming and safe reconciliation

Auto-derive a **deterministic canonical name** from `(table, columns, unique, where-hash)`
— e.g. `pdbidx_meals_user_id`, `pdbidx_mealTags_meal_id_tag_id`. Allow a human override
for readability, but derive by default.

Deterministic naming is not cosmetic: it is what makes two-way reconcile **safe**.
`migrate()` computes the declared name set, reads `PRAGMA index_list`, creates missing,
drops extra — **but only extras carrying the `pdbidx_` prefix.** Never touch
`sqlite_autoindex_*` (SQLite's own UNIQUE-backing indexes) or any unprefixed index a
human made by hand. That prefix-namespacing is the one rule that keeps "drop what isn't
declared" from being a footgun. So: always named (auto), always namespaced, reconcile
only within the namespace.

## `UNIQUE` indexes are also the auth constraint

The `UNIQUE` constraint that auth needs (RFC 0001) *is just a unique index*. So the same
declarative manifest that handles performance indexes also gives the correctness
constraint: `{ table: "users", columns: ["username"], unique: true, collate: "nocase" }`
is simultaneously the dedup guarantee and the case-insensitive login lookup. No separate
"constraints" concept — unique indexes cover it.

## Relationship to the two-tier model

Two tiers (see RFC 0004), and indexes are firmly in the top one:

- **Declarative-reconciled** for structure *and* indexes (columns add-only, indexes
  two-way).
- **Imperative-ledgered** only for data backfills.

### DECISION — index ops are also recorded in the ledger

The design above reconciles indexes purely from live DB state (no ledger needed, since
`PRAGMA index_list` is the source of truth). **Project decision: additionally record each
CREATE/DROP INDEX in the migrations ledger** (a row with a timestamp — the applied-flag
from RFC 0004), so every schema-affecting op has an audit trail in one place alongside
data migrations. Reconciliation still *derives intent* from the declared config; the
ledger is the write-log of what was applied, not the source of truth for what should
exist. (The trade-off — indexes touched out-of-band can drift from the ledger — is
accepted; reconciliation self-heals the actual index set regardless.)

## Operational note

Index reconciliation at startup is fine at current scale (a single SQLite file, personal
app). If data ever grows large, index creation is the one "migration" that can be slow
(it locks/scans), so at that point it may warrant gating. Minor, not a concern today.
