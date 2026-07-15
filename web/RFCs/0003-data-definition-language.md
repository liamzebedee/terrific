# RFC 0003: Data definition language (schema, typed client, RPC layer)

- **Status:** Descriptive (documents the current implementation)
- **Author:** liamzebedee
- **Created:** 2026-07-09
- **Scope:** protodatabase / mealplanner

## Summary

mealplanner's data definition language is **one protobuf message → the whole stack**.
A single `message Database` is the source of truth; from it a code generator emits the
SQL schema, the typed row types, and a Kysely-style typed client. Services read and write
that client directly (no store/adapter layer). The wire layer is Connect-RPC over JSON,
also generated from `.proto`. This RFC documents how the pieces fit as of 2026-07-09,
with file references.

## Layers, end to end

```
src/proto/models/*.proto           ← hand-written proto (models + message Database)
        │  bun run gen  (protodatabase/cli.ts → protoc → reflect → emit)
        ▼
src/proto/gen/                      ← GENERATED, never hand-edited
  ├─ schema.gen.sql                 ← CREATE TABLE/VIEW DDL
  ├─ schema.gen.ts                  ← Schema interface (table → {select,insert} types)
  ├─ client.gen.ts                  ← typed Db wrapper
  └─ database_pb.gen.ts             ← protobuf-es messages
        │
        ▼
src/proto/connection.ts            ← opens SQLite, `planner.migrate()` at startup
        │
        ▼
src/api/services/*.ts              ← services use `planner` client directly, owner-scoped
        │  Connect-RPC over JSON (src/api/connect.ts, router.ts)
        ▼
src/rpc.ts                         ← one transport + a client per service (frontend)
```

## The database spec: `message Database` → SQL

The framework lives in `protodatabase/` (`cli.ts`, `plan.ts`, `client.ts`,
`generate.ts`, `codegen.ts`). The rule that makes it legible: **one top-level field of
`message Database` = one SQL table, and the physical identity of everything is the proto
field NUMBER, never the name.**

Current schema — `src/proto/models/database.proto:31-42`:

```proto
message Database {
  repeated planner.v1.Meal meals = 1;             // PK = id
  repeated planner.v1.MealList meal_lists = 2;    // PK = id
  repeated planner.v1.Nutrition nutrition = 3;    // PK = key  (shared global food DB)
  repeated planner.v1.Supplement supplements = 6; // PK = key
  repeated planner.v1.DaySim daysim = 9;          // one row per owner
  repeated planner.v1.Whiteboard whiteboard = 10; // one row per owner
  repeated planner.v1.Settings settings = 11;     // one row per owner
  repeated planner.v1.Profile profile = 12;       // one row per owner
  repeated planner.v1.User users = 13;            // accounts
  repeated planner.v1.SlotItem slot_items = 14;   // relational week/log plan
}
```

Planning rules (`protodatabase/plan.ts`):

- **One table per field.** `planTable` (`plan.ts:71-79`) rejects any field that is not
  `repeated <Message>`. Physical table name = `t<fieldNumber>` (so `meals` → `t1`,
  `slot_items` → `t14`).
- **Column kinds** (`planColumn`, `plan.ts:49-60`): a scalar/enum field → a typed,
  queryable column (`TEXT`/`REAL`/`INTEGER`) named `f<fieldNumber>`; a **message,
  repeated, or map field → a `BLOB`** holding that one field's protobuf encoding.
  Nullability comes from proto3 `optional` (explicit presence).
- **Primary key** (`pkColumn`, `plan.ts:64-67`): the row message's scalar `id` **or**
  `key` field becomes the PK; otherwise an implicit rowid. (See RFC 0001 on why PK is
  identity + access path, not "safety".)
- **DDL** (`createTableSql`, `plan.ts:87-97`): `CREATE TABLE IF NOT EXISTS t<n> (…, PRIMARY KEY(…))`,
  with a `-- realName` comment per column.
- **Legibility view** (`createViewSql`, `plan.ts:101-106`): a `CREATE VIEW "<realName>" AS
  SELECT f1 AS "id", … FROM t<n>` per table, so a plain `sqlite3` shell shows real names
  even though storage is `tN`/`fN`.

Why `tN`/`fN` physical names: proto field renames never touch stored data, and reordering
fields in the `.proto` is purely cosmetic. This is the foundation the evolution story
(RFC 0004) is built on.

## The typed client

`class Db` (`protodatabase/client.ts:199-256`) is a small Kysely-style query builder,
typed against the generated `Schema`:

- Builders `selectFrom` / `insertInto` / `updateTable` / `deleteFrom`
  (`client.ts:215-226`).
- Proto-field-name → `fN` column translation and value coercion in `compileWhere`
  (`client.ts:68-79`), `encodeColumn` (`client.ts:45-49`), `decodeRow`
  (`client.ts:52-65`): scalars stored as typed values (bool ⇄ 0/1); BLOB fields
  round-tripped through `toBinary(create(row,{[field]:v}))` / `fromBinary`.
- **UPSERT on PK** (`InsertBuilder.execute`, `client.ts:135-150`):
  `INSERT … ON CONFLICT(<pk>) DO UPDATE SET col = excluded.col …`. This is why singleton
  rows (`profile`, `settings`) and composite-PK join rows (RFC 0001) can be written
  idempotently.
- **Equality-family filters only** (`Op`, `client.ts:27`); filtering on a BLOB column
  throws (`client.ts:74`). Sufficient for `where("owner","=",uid)` scoping.

## Services: no store layer, owner-scoped

Services (`src/api/services/*.ts`) implement the generated Connect service types and
talk to the `planner` client **directly** — no repository/adapter/parallel-type layer.
`profile.ts` is the tightest example: the proto message *is* the row.

Every table except `users` carries an `owner INTEGER` column (the User id). Scoping is
enforced in the service layer, type-safely:

- `src/api/services/data.ts` — `getData`/`putData` scope by
  `requireSession(ctx).user.id` (`data.ts:154-162`); helpers `own()` / `syncKeyed` /
  `setOne` all `.where("owner","=",uid)` (`data.ts:43-64,100-102`); a generic
  `OwnedTable` type (`data.ts:31-33`) keeps it honest.
- **`nutrition` is the deliberate exception** — a shared global food database, never
  owner-scoped, never owner-deleted (`data.ts:110-111,137-138`).

This is where referential integrity lives (RFC 0001): there are no SQL foreign keys;
cross-entity references are plain id columns resolved and enforced here.

## The typed RPC layer

**Connect-RPC over JSON, unary only** — not gRPC-web, not raw gRPC.

- Service contracts: `src/proto/services/*.proto` (`auth`, `data`, `nutrition`,
  `profile`, `admin`).
- **Server per-request handler** (`src/api/connect.ts`, `connectRoutes`): one Bun POST
  route per method at `/rpc/<package>.<Service>/<Method>` (`connect.ts:49`); decodes JSON
  with `ignoreUnknownFields:true` — the additive-evolution contract at the wire boundary
  (`connect.ts:54`); attaches the session (`connect.ts:61`); encodes the response;
  maps `ConnectError` codes to HTTP status via `HTTP_STATUS` (`connect.ts:22-36`,
  e.g. `Unauthenticated→401`, `PermissionDenied→403`, `NotFound→404`,
  `AlreadyExists→409`; unlisted → 500).
- **Session as transport-layer context** (`src/api/session.ts`): `getSession(req)` reads
  `Authorization: Bearer <jwt>`, verifies, loads the user row (`session.ts:34-42`);
  `requireSession(ctx)` throws `Unauthenticated` (`session.ts:45-48`). Built once per
  request at `connect.ts:61` and passed as each handler's second arg — the
  interceptor-style attach point.
- **Router** (`src/api/router.ts`): registers the five services plus one non-RPC route
  `/api/mcps/afcd`. Caveat (`router.ts:10-12`): Bun reads `routes` once at startup, so a
  *new* RPC method needs a restart even under `--hot`.
- **Frontend transport** (`src/rpc.ts`): a single
  `createConnectTransport({ baseUrl: "/rpc", interceptors: [auth] })` and one client per
  service (`rpc.ts:46-53`). The `auth` interceptor (`rpc.ts:31-44`) reads
  `localStorage["auth.token"]`, sets the Bearer header, and on a 401 drops the token and
  fires an `auth-changed` event.

Auth specifics (bcrypt via `Bun.password`, hand-rolled HS256 JWT in `src/api/jwt.ts`,
register/login/onboarding in `src/api/services/auth.ts`, seed-copy in
`src/api/services/seed.ts`) are the accounts feature riding on this layer. **Note there
is no token refresh** — the 7-day JWT expires and a 401 forces re-login
(`rpc.ts:37-42`); a refresh flow is a known gap.

## Relational

Relationships are conventions, not DDL constructs (full treatment in RFC 0001). In the
current schema:

- **Soft references**: `Meal.list` → a `MealList.id` (or `"archived"`), `SlotItem.meal_id`
  → `Meal.id` — plain string columns, resolved in services, no FK enforcement.
- **`slot_items` (t14)** is the relational replacement for the old per-day `Slots` blob
  tables (`week`/`log`) — the week/log plan is now first-class rows rather than an opaque
  blob, which is what makes owner-scoping and per-item editing tractable.
- **Ownership** is a relation too: the `owner INTEGER` column on every non-`users` table
  is a soft reference to `User.id`.

## Documents

Two distinct "document" notions exist; neither is a general JSON store:

1. **Protobuf BLOB documents inside tables.** Nested/repeated/map fields are stored as
   protobuf bytes in `BLOB` columns (e.g. `nutrition.macros`, `supplements.parsed`,
   `daysim.slots/meals/boluses`, `whiteboard.items`, all `profile.*` message columns).
   These are protobuf, not JSON.
2. **Legacy `kv` JSON-document store (being phased out).** `src/proto/legacy_import.ts`
   reads a pre-protodatabase generic `kv(key)→value` table of JSON documents. It is the
   source the **profile self-heal** falls back to: on first run or when a `profile` row
   fails to proto-decode, `profile.ts` drops the bad row and re-imports from the legacy
   kv `"profile"` document, else seeds from `requirements.json` (`profile.ts:32-47`,
   `legacy_import.ts:82-85`). Migration `001` drops the `kv` table, so post-migration
   this path yields nothing (guarded). `legacy_import.ts` is explicitly marked for
   deletion once every DB is migrated.

There is **no** general-purpose JSON/kv/document tier in the current schema — the only kv
is the legacy one on its way out. The `Data`/RDI "documents" in `src/rpc.ts` are
in-memory JSON projections of proto messages at the client boundary, not storage.

## Non-goals / known gaps

- **CLI is a single-shot generator, no subcommands** (`protodatabase/cli.ts`): positional
  `<database.proto>` + `--gen-dir/--schema-out/--types-out/--client-out` (+ optional
  `--message/--open-name/--proto-path`). No migration verb. (See RFC 0004.)
- **No declarative index manifest yet** (see RFC 0002 for the proposed shape).
- **No token refresh** (above).
- `PROJECT_LAYOUT.md` is auto-generated and currently stale — trust the files, not it.
