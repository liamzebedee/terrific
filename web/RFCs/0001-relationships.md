# RFC 0001: Relationships

- **Status:** Draft
- **Author:** liamzebedee (design discussion, captured)
- **Created:** 2026-07-09
- **Scope:** protodatabase / mealplanner

## Summary

How relationships are modelled in the protodatabase layer: as **soft references**
(plain id columns) plus explicit join tables, enforced in the service layer — **not**
as SQL `FOREIGN KEY` constraints. This RFC records why, and separates the four
different things people bundle under the word "keys" (`PRIMARY KEY`, `UNIQUE`, plain
`INDEX`, `FOREIGN KEY`) so the design objection lands on the right one.

## Decision

- **`PRIMARY KEY` / rowid — keep.** Identity + physical access path. Not "safety".
- **`UNIQUE` — keep, for a tiny set of identity columns** (e.g. `username`). This one
  survives the append-only argument.
- **plain `INDEX` — add freely** wherever we query/join. Pure performance, no semantics.
  (Covered in detail by RFC 0002.)
- **`FOREIGN KEY` constraint — do not use.** Redundant with a strong type system + an
  append-only model. Referential integrity is enforced in services.
- **Relationships are conventions, not DDL constructs.** has-many = an explicit fk
  column + an index + query helpers. many-to-many = an explicit join-row message with
  two id columns + a composite `PRIMARY KEY`. No relations DSL.

## Context

The framework has no notion of relations by design. The only cross-entity references
today are **soft string references** resolved in application code — e.g. `Meal.list` →
a `MealList.id` (or `"archived"`/unset), and `SlotItem.meal_id` → `Meal.id`. Both are
plain strings with no enforcement. No SQL foreign keys are ever emitted; table creation
emits columns + `PRIMARY KEY` only.

## Why no SQL foreign keys

### The SQLite mechanics

SQLite's `ALTER TABLE` is deliberately tiny: `RENAME TABLE`, `ADD COLUMN`,
`RENAME COLUMN`, `DROP COLUMN`. There is **no** `ALTER TABLE ... ADD CONSTRAINT` /
`ADD FOREIGN KEY`.

The reason is how SQLite stores schema: it keeps the literal `CREATE TABLE` *text* in
`sqlite_master` and enforces constraints (FK, CHECK, UNIQUE) by parsing that stored
text. A constraint is not a separate catalog object you can append — it is baked into
the table definition. So to add an FK to an existing table you must run the documented
"12-step" rebuild: create a new table with the constraint, `INSERT INTO new SELECT * FROM old`,
drop the old, rename the new. `ADD COLUMN` is permitted because appending a column with
a default does not require re-validating or rewriting existing rows; adding a constraint
would.

**Important nuance (this corrects an earlier overstatement):** a *new nullable column*
is allowed to carry a `REFERENCES` clause via `ADD COLUMN`, provided its default is
`NULL` (an explicit SQLite rule). So
`ALTER TABLE meals ADD COLUMN user_id TEXT REFERENCES users(id) DEFAULT NULL`
works additively — no rebuild. The rebuild is only *forced* when retrofitting an FK
onto a column that **already exists** (e.g. making today's `Meal.list` string reference
`mealLists`), or adding a composite FK, or adding `PRIMARY KEY`/`UNIQUE` to an existing
column. Because protodatabase only ever *adds* new columns (keyed by field number), new
FK columns would in fact be fine. So "FKs fight the additive migrator" is too strong; it
only applies to retrofitting existing columns.

The conclusion still holds, but for a better reason (below).

### "Keys" is four different features — the objection only lands on one

The word "keys" hides four features that have nothing to do with each other:

1. **`PRIMARY KEY` / rowid — keep, and it is not safety.** This is identity plus the
   physical access path. In SQLite the PK *is* the index that makes "get meal by id"
   `O(log n)` instead of a full table scan. protodatabase already uses the `id`/`key`
   field as the PK. Drop it and every lookup becomes a scan. This is the one most easily
   conflated with FKs when it is really a different animal.

2. **`UNIQUE` — keep for a *tiny* set, and it survives the append-only argument.**
   This is the one place the "keys are needless" argument fails. Auth needs a unique
   constraint on `username` (and/or email). Not for cascade, not for deletion — for
   **correctness under concurrency**: two people hitting register with the same username
   simultaneously, the service does "select → none found → insert" on both, and now two
   accounts own the same login. A unique index is the only thing that reliably says no.
   Append-only makes it worse (both duplicates persist forever). So: unique on identity
   columns, nowhere else.

3. **plain `INDEX` — pure performance, zero semantics, add freely.** "Things we need
   together" just want indexes. A many-to-many join table wants an index on each fk
   column so joins don't scan. A performance decision, not a constraint. See RFC 0002.

4. **`FOREIGN KEY` constraint — skip it.** This is the *only* one of the four that is
   purely enforcement + cascade. In an append-only model, `ON DELETE CASCADE` is moot
   (nothing deletes), and referential integrity can be enforced in services or simply
   tolerated as dangling refs — which the app already does (`Meal.list` can point at
   `"archived"` or nothing, no FK, works fine). FK constraints buy "the DB refuses a
   `meal_id` pointing at no meal." With generated ids and services that check, that is
   redundant.

**Scoreboard:** PK yes (identity/perf), UNIQUE yes for a handful of auth columns
(correctness), INDEX yes where you join (perf), FK no (redundant enforcement). The
original instinct that keys are mostly needless was right; it was aimed slightly wide
because "keys" swept in PK and UNIQUE, which are not the thing being objected to.

## Modelling relationships

### has-many

A has-many is *just* an explicit fk column plus an index on it. Do **not** build a DSL
that generates a table and hides the column — that fights the "explicit columns shown at
all times" value. Keep the column explicit (`user_id`), declare an index on it (RFC 0002),
and let "has many" be a **query helper / naming convention**, not a schema-generation
macro.

### many-to-many

A join table is two id columns, and mostly it is indexes. But give it a **composite
`PRIMARY KEY` on `(a_id, b_id)`** — not for safety, for **idempotency**. protodatabase
UPSERTs on the PK. Without a composite PK, "add tag X to meal Y" run twice inserts two
rows; with it, the second run is a no-op.

This matters directly for migrations (RFC 0004): backfill migrations are supposed to be
idempotent and re-runnable. If a migration populates a join table, the composite PK is
what makes re-running it a no-op instead of doubling rows. It is the same mechanism that
lets the singleton `profile`/`settings` rows upsert cleanly today. So the one bit of
"keys" one might dismiss as ceremony is the thing that makes the append-only migration
story converge.

The join table is written as an explicit `repeated JoinRow` message in `message Database`
with the two id columns declared by hand — exactly the explicitness we want; the join
table is a visible message, not a generated side effect.

### has-many-through

`has-many-through` (e.g. a user has many patients *through* appointments) is a join
across two fks — pure syntactic sugar. Not essential; **skip it.**

## Summary of the resulting shape

Build it with:
- `PRIMARY KEY`s (including composite PKs on join tables),
- a few `UNIQUE`s for auth identity,
- plain indexes for joins (RFC 0002),
- and **no** `FOREIGN KEY` constraints.

This is fully consistent with "append-only, no destructive migrations, explicit tables
shown in code", and it drops the one feature (FK) that would otherwise ever force a
table rebuild.
