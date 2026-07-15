// Auth, resolved at the transport layer. The Connect adapter runs getSession
// once per request (like a gRPC interceptor) and hands the result to the impl
// on the request Context; handlers read `ctx.session`, never the raw request.
//
// getSession reads the `Authorization: Bearer <jwt>` header, verifies it, and
// loads the user. Public RPCs (register, login) tolerate a null session;
// everything owner-scoped calls requireSession(ctx), which 401s without one.

import { Code, ConnectError } from "@connectrpc/connect";
import type { DescService, DescMethodUnary, MessageShape, MessageInitShape } from "@bufbuild/protobuf";
import { db } from "../proto/connection.ts";
import { verifyToken } from "./jwt.ts";

export interface Session {
  // `id` is the internal int PK (owner scoping); `uid` is the public UUIDv7.
  user: { id: number; uid: string; email: string; username: string };
}

// What every RPC handler receives as its second argument.
export interface Context {
  session: Session | null;
}

// The typed shape of a service implementation for OUR transport. It mirrors
// @connectrpc's ServiceImpl — each method keeps its exact request/response
// types, drawn straight from the generated service descriptor — but the second
// argument is our Context (populated by connectRoutes), not Connect's
// HandlerContext. Every RPC here is unary, which is all connectRoutes serves.
export type ServiceHandlers<Desc extends DescService> = {
  [P in keyof Desc["method"]]: Desc["method"][P] extends DescMethodUnary<infer I, infer O>
    ? (request: MessageShape<I>, ctx: Context) => Promise<MessageInitShape<O>> | MessageInitShape<O>
    : never;
};

export function getSession(req: Request): Session | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const uid = verifyToken(auth.slice("Bearer ".length)); // token subject = User.uid
  if (uid == null) return null;
  const u = db.selectFrom("users").selectAll().where("uid", "=", uid).executeTakeFirst();
  if (!u) return null;
  return { user: { id: u.id, uid: u.uid, email: u.email, username: u.username } };
}

// The authenticated session, or a 401 for callers of owner-scoped RPCs.
export function requireSession(ctx: Context): Session {
  if (!ctx.session) throw new ConnectError("not authenticated", Code.Unauthenticated);
  return ctx.session;
}
