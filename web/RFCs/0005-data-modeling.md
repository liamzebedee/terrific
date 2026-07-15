# RFC 0005: Data modeling — when to normalize, and identity

- **Status:** Draft (identity: one open decision, marked below)
- **Author:** liamzebedee (design discussion, captured)
- **Created:** 2026-07-09
- **Scope:** protodatabase / mealplanner

## Summary

Two modeling decisions that recur: **(1) when to make something a table vs. a nested
proto blob**, and **(2) how identity/ids work**. The short version: normalize only when
you need dedup or per-item queryability/addressing — otherwise store a nested proto blob;
and mint **UUIDv7** string ids for anything shareable, minting in app code (no
auto-increment machinery, no separate public slug).

## Part 1 — When to normalize (table vs. nested blob)

protodatabase lets you choose per field: a top-level `repeated <Message>` field in
`message Database` becomes its **own table**; a message/repeated/map field *inside* a row
becomes a **protobuf BLOB column** on that row. The question is which to use.

### Normalization only pays off two ways — and we need neither by default

1. **Dedup** — one canonical row referenced many times (e.g. dedup ingredient names).
   Real, but not worth it here; we have no use case that needs it.
2. **Referential integrity on update/delete** — moot in an append-only, no-FK model
   (RFC 0001).

So do **not** normalize for its own sake. Storage is *not* a reason either (see Part 1's
note below).

### The decision rule: queryability, not tidiness

- **Make it a table** when items need independent **addressing, sharing, or per-item
  queries/filters**.
  - `meals` — independently shareable/addressable → table.
  - `slot_items` — the week/log plan; you edit individual slots and filter by owner/day,
    which is exactly why migration `001` *exploded* them out of the old per-day `Slots`
    blobs into a relational table.
- **Keep it a nested proto blob** when the collection is only ever read/written **as a
  whole**.
  - `whiteboard.items` — already a blob (one `Whiteboard` row per owner); correct as-is.
  - meal `ingredients` — only accessed as part of the meal → blob.
  - `profile.*` — one row per owner, always loaded whole → blobs.

### Storage is never the reason

Protobuf encodes field **numbers** (varint tags), not field names. There is zero
per-row column-name overhead on disk — the verbose JSON in the admin UI is just a render.
So "add scalar columns to save space" is a non-reason; a blob is compact regardless of
how verbose the field names are. This is also why nested-blob modeling is cheap.

The *one* cost of a blob is that protodatabase **cannot filter or index a field inside
it** (it throws on a blob-column filter). So the axis that forces a field out of a blob
into a scalar column is **queryability, not space**: promote a field to a column only
when you need to `WHERE`/index on it across rows. For one-row-per-owner data you never
do.

## Part 2 — Identity

### Convention: UUIDv7 string ids for minted/shareable entities

- Entity ids are **UUIDv7**, stored as `string id` (TEXT).
- **v7, not v4:** time-ordered (48-bit ms timestamp + 74 random bits), so B-tree inserts
  stay append-friendly (index locality) while remaining unguessable. v4 is fully random
  and fragments the index. Caveat: v7 leaks approximate creation time to whoever holds
  the id — harmless for a shared meal; use v4 for anything where a creation-time leak
  matters.
- **Mint in app code** at insert time. This is *simpler* than the auto-increment
  machinery considered earlier (no `last_insert_rowid()` readback, no proto3 `0`-sentinel,
  no `max(id)+1`) — those were solving a problem UUIDs make disappear.
- **No separate public slug.** Because every id is already unguessable, ids are safe in
  any URL; there is no second "public handle" id system to maintain (this supersedes the
  public-slug note in RFC 0001).

Today meals/meal-lists already mint UUIDs, but via `crypto.randomUUID()` = **v4**
(`src/helpers.ts:32`, `src/api/services/seed.ts:18,26`). Adopting v7 is a generator
swap going forward; **existing v4 ids stay valid and are left as-is** (they are already
unguessable, and a v4 id cannot be meaningfully rewritten as v7 — v7 encodes a creation
time we don't have).

Generation note: backend can use `Bun.randomUUIDv7()`; the **frontend** (`helpers.ts`,
browser) has no native v7, so it needs a small ~15-line v7 helper (Web Crypto for the
random bits + `Date.now()` for the timestamp). Both must produce spec-compliant v7.

### Natural keys are the explicit opt-out

Where the domain has a real natural key, use it instead of a surrogate: `nutrition` and
`supplements` are keyed by a domain string (`key` / afcdKey), not a UUID. That stays.
The convention is: **default = UUIDv7 surrogate `id`; opt-out = a declared string natural
key** where one genuinely exists.

### DECISION — add a `User.uid` (append-only), don't convert the PK

Changing `User.id` (an int PK) to a string in place is not allowed: it breaks wire
compatibility on that field and, more importantly, breaks every already-applied migration
that references int user ids — and migrations are immutable, point-in-time scripts that
stay in the typecheck. The append-only rule (RFC 0004) applies: **you add a new field,
you never change an existing one in place.**

So the implemented design:

- `User.id` stays `int32` — the internal PRIMARY KEY and the `owner` reference on every
  table (unchanged, so migrations 001–003 keep compiling against their int logic).
- `User` gains **`string uid = 8`** — the stable, public, non-enumerable **UUIDv7**
  identity. It is what tokens carry (JWT subject), what `UserView.id` exposes, and what
  the frontend/URLs use. The int `id` is never exposed.
- `owner` columns stay `int32` (referencing `User.id`). No column-type change, no owner
  remap, no table rebuild.
- Migration `006-user-uid.ts` backfills a `uid` for every existing account (idempotent).

This is effectively the int-internal-PK + UUID-public-identity shape: the append-only
constraint on a primary key naturally lands here rather than on a single uniform UUID PK.
Existing shareable entities (meals/meal-lists) keep their UUIDs; new ids mint v7.

## Relationship to other RFCs

- Relationships and the no-FK stance: RFC 0001.
- Indexes (including how a promoted-to-column field gets indexed): RFC 0002.
- The typed client / blob storage mechanics: RFC 0003.
- Migration mechanics for the units-enum and any id changes: RFC 0004.
