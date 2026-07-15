// app.v1.TestService — the minimal RPC impl. Public (no session), no DB: it just
// echoes its input, so it proves the Connect transport works end-to-end.

import { TestService, type PingRequest } from "../../proto/index.ts";
import type { ServiceHandlers } from "../session.ts";

export const testServiceImpl: ServiceHandlers<typeof TestService> = {
  ping(req: PingRequest) {
    return { message: req.message };
  },
};
