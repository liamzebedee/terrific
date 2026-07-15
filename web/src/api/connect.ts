// Minimal Connect-protocol adapter for Bun.serve routes.
//
// Serves unary RPCs over the Connect JSON protocol (HTTP POST, JSON body) —
// the same protocol @connectrpc/connect-web speaks — without pulling in the
// Node server adapter. Each service method becomes one Bun route:
//   /rpc/<package>.<Service>/<Method>
//
// Implementations are typed with @connectrpc/connect's ServiceImpl, so the
// generated proto service IS the backend spec. Unknown request fields are
// ignored (additive-evolution contract: old server must accept new client).

import { create, fromJson, isMessage, toJson, type DescService, type JsonValue } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { getSession, type Context } from "./session.ts";

// Connect error-code string ("invalid_argument") from the enum name ("InvalidArgument").
function codeString(code: Code): string {
  return Code[code].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// HTTP status per Connect protocol error-code mapping (unlisted → 500).
const HTTP_STATUS: Partial<Record<Code, number>> = {
  [Code.Canceled]: 408,
  [Code.DeadlineExceeded]: 408,
  [Code.InvalidArgument]: 400,
  [Code.OutOfRange]: 400,
  [Code.FailedPrecondition]: 400,
  [Code.Unauthenticated]: 401,
  [Code.PermissionDenied]: 403,
  [Code.NotFound]: 404,
  [Code.Unimplemented]: 404,
  [Code.AlreadyExists]: 409,
  [Code.Aborted]: 409,
  [Code.ResourceExhausted]: 429,
  [Code.Unavailable]: 503,
};

type RouteHandler = { POST: (req: Request) => Promise<Response> };

export function connectRoutes(
  services: Array<[DescService, Record<string, (...args: never[]) => unknown>]>,
): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {};
  for (const [svc, impl] of services) {
    for (const method of svc.methods) {
      if (method.methodKind !== "unary") continue;
      const fn = impl[method.localName];
      if (!fn) throw new Error(`${svc.typeName}: no implementation for ${method.localName}`);
      routes[`/rpc/${svc.typeName}/${method.name}`] = {
        POST: async (req: Request) => {
          try {
            let input;
            try {
              input = fromJson(method.input, (await req.json()) as JsonValue, { ignoreUnknownFields: true });
            } catch (e) {
              throw new ConnectError((e as Error).message, Code.InvalidArgument);
            }
            // Transport-layer auth: resolve the caller once per request into the
            // Context handed to the impl (like a gRPC interceptor populating the
            // context). Handlers read ctx.session; the rest ignore it.
            const ctx: Context = { session: getSession(req) };
            const output = await (fn as unknown as (req: unknown, ctx: Context) => unknown)(input, ctx);
            const msg = isMessage(output, method.output) ? output : create(method.output, output as never);
            return Response.json(toJson(method.output, msg));
          } catch (e) {
            const ce = ConnectError.from(e);
            if (ce.code === Code.Internal) console.error(`[rpc] ${svc.typeName}/${method.name}:`, e);
            return Response.json(
              { code: codeString(ce.code), message: ce.rawMessage },
              { status: HTTP_STATUS[ce.code] ?? 500 },
            );
          }
        },
      };
    }
  }
  return routes;
}
