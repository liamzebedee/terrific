# App Template

A minimal full-stack template: a typed-RPC API over SQLite, served with a React
SPA, all on [Bun](https://bun.sh). Protobuf is the single source of truth — the
database schema, the typed DB client, and the API contract all fall out of the
`.proto` files.

## Stack

- **Bun** — runtime, bundler, dev server (HMR), and test runner.
- **Connect (protobuf)** — the JSON API is typed RPC. Services are defined in
  `src/proto/services/*.proto` and implemented one file per service under
  `src/api/services/`.
- **protodatabase** — `message Database` (`src/proto/models/database.proto`) *is*
  the schema; `bun run gen:db` generates the SQL and a typed, Kysely-style query
  builder. See `protodatabase/README.md`.
- **React 19** — a client-rendered SPA (`src/app.tsx`), with server-side
  rendering of the document `<head>` for social crawlers (`src/entry-server.tsx`).
- **Auth** — email/password with bcrypt + HS256 JWTs (`src/api/jwt.ts`,
  `src/api/services/auth.ts`); the client caches the token (`src/auth-store.ts`).

## Run

```sh
bun install
bun run dev          # http://localhost:3001, HMR on
bun run typecheck    # tsc --noEmit — the gate
bun run gen          # regenerate proto code + DB client after editing .proto
```

## Layout

```
main.ts                     server: wires API routes + SPA serving
src/config.ts               typed env (APP_ENV, DB_PATH, PORT, JWT_SECRET)
src/proto/
  models/*.proto            messages that ARE database tables (user, item)
  models/database.proto     the schema — one `repeated Table` per field
  services/*.proto          RPC service definitions (auth, item, test)
  connection.ts             opens the DB, reconciles schema; exports `db`
  index.ts                  barrel re-export of all generated types
src/api/
  connect.ts                Connect-protocol adapter for Bun.serve
  session.ts                per-request auth context + ServiceHandlers type
  router.ts                 registers every service impl as routes
  services/*.ts             one impl per service
src/rpc.ts                  the typed client (one client per service)
src/pages/, src/components/ the example UI (ItemsPage, ItemCard, AuthPage)
```

## The example

A generic **Items** CRUD wires the whole stack together end-to-end and is the
thing to copy for a real resource:

| layer      | file |
|------------|------|
| model → DB | `src/proto/models/item.proto` → a table in `database.proto` |
| RPC        | `src/proto/services/item.proto` |
| API impl   | `src/api/services/item.ts` (owner-scoped) |
| client     | `rpc.item.*` in `src/rpc.ts` |
| page       | `src/pages/ItemsPage.tsx` |
| card       | `src/components/ItemCard.tsx` |

`src/proto/services/test.proto` + `src/api/services/test.ts` are the smallest
possible service — a public `Ping` that echoes its input, no auth or DB.

## Adding a service

1. Add a `.proto` under `src/proto/services/` (and any model under `models/`,
   registering new tables in `database.proto`).
2. `bun run gen`.
3. Implement it under `src/api/services/`, typed as
   `ServiceHandlers<typeof YourService>`.
4. Register it in `src/api/router.ts`, and add a client in `src/rpc.ts`.
5. Restart the dev server — `Bun.serve` reads `routes` once at startup.
