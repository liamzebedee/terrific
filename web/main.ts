// App server — the "run the server" plumbing.
//
//   - `apiRoutes` dispatches the typed-RPC API (src/api/) and serves the SPA
//
// SPA serving differs by environment:
//   - production: the render server (src/entry-server.tsx) SSRs each document's
//     <html> so the <head> is correct for social crawlers, then the client boots
//     the SPA into #root. The client bundle is built once (src/spa.ts) and its
//     chunks are served as routes.
//   - development: Bun's fullstack HTMLBundle serves src/index.html with HMR
//     (hot-reload the browser on client edits); no SSR head is needed locally.
//
// All domain logic lives under src/api/ and src/proto/. Importing the proto
// connection opens the DB and reconciles the schema as a side effect.
//
// Env: APP_ENV (local | prod, default local — picks data/<env>/db.sqlite3 and
//      loads .env.<env>), PORT (default 3001), DB_PATH override,
//      NODE_ENV=production disables HMR + enables SSR.

import { APP_ENV, DB_PATH, PORT } from "./src/config.ts";
import "./src/proto/connection.ts";
import "./scripts/proto-watch.ts"; // dev-only: hot-regenerate src/proto/gen on proto changes
import { apiRoutes } from "./src/api/router.ts";
import { renderDocument } from "./src/entry-server.tsx";
import { spa } from "./src/spa.ts";

const prod = process.env.NODE_ENV === "production";

// SPA routes: in prod, serve the built chunks + SSR every document via "/*"; in
// dev, hand "/*" to Bun's fullstack HTMLBundle (HMR).
const spaRoutes = prod
  ? { ...spa!.routes, "/*": renderDocument }
  : { "/*": (await import("./src/index.html")).default };

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  // HMR adds React-Refresh per-render instrumentation; set HMR=0 for snappier
  // (but no-hot-reload) dev renders.
  development: prod ? false : { hmr: process.env.HMR !== "0" },
  routes: {
    ...apiRoutes,
    ...spaRoutes,
  },
});

console.log(`App [${APP_ENV}]: http://localhost:${server.port} (db: ${DB_PATH})`);
