// Typed RPC client — the single endpoint to the API backend.
//
// One Connect transport at /rpc, one client per generated service. Method calls
// are fully typed end-to-end from src/proto/services/*.proto:
//   rpc.test.ping({ message: "hi" })          → PingResponse
//   rpc.auth.login({ email, password })        → LoginResponse
//   rpc.item.listItems({})                     → ListItemsResponse

import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { clearAuth, getToken } from "./auth-store.ts";
import { AuthService, ItemService, TestService } from "./proto/index.ts";

// Attach the stored JWT to every request, and on a 401 for an authenticated
// request drop the session so the app falls back to login. The token store
// (auth-store.ts) is dependency-free precisely so the transport can read it
// without an import cycle back through session.ts.
const auth: Interceptor = (next) => async (req) => {
  const token = getToken();
  if (token) req.header.set("Authorization", `Bearer ${token}`);
  try {
    return await next(req);
  } catch (e) {
    if (token && e instanceof ConnectError && e.code === Code.Unauthenticated) {
      clearAuth();
      window.dispatchEvent(new Event("auth-changed"));
    }
    throw e;
  }
};

const transport = createConnectTransport({ baseUrl: "/rpc", interceptors: [auth] });

export const rpc = {
  auth: createClient(AuthService, transport),
  item: createClient(ItemService, transport),
  test: createClient(TestService, transport),
};

// User-facing error text: the server message without the Connect code prefix.
export const errMsg = (e: unknown): string =>
  e instanceof ConnectError ? e.rawMessage : ((e as Error)?.message ?? String(e));
