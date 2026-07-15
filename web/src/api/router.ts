// API route registry, in the shape Bun.serve expects for `routes`.
//
// The entire JSON API is typed RPC (Connect protocol), generated from
// src/proto/services/*.proto and implemented one file per service under
// src/api/services/:
//   /rpc/app.v1.<Service>/<Method>
//
// NOTE: Bun.serve reads `routes` once at startup, so `--hot` will NOT pick up a
// newly added route key — after adding an RPC method, restart the server, or
// the path falls through to the SPA fallback and returns HTML.

import { AuthService, ItemService, TestService } from "../proto/index.ts";
import { connectRoutes } from "./connect.ts";
import { authServiceImpl } from "./services/auth.ts";
import { itemServiceImpl } from "./services/item.ts";
import { testServiceImpl } from "./services/test.ts";

export const apiRoutes = {
  ...connectRoutes([
    [AuthService, authServiceImpl],
    [ItemService, itemServiceImpl],
    [TestService, testServiceImpl],
  ]),
};
