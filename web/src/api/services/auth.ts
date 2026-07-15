// app.v1.AuthService — register, login, me, change password.
//
// Passwords are bcrypt-hashed (Bun.password) and never stored or returned in the
// clear. Register/Login mint a JWT (src/api/jwt.ts) the client sends back as a
// Bearer token; Me resolves the caller from that token via the request Context.

import { Code, ConnectError } from "@connectrpc/connect";
import {
  AuthService, type User,
  type ChangePasswordRequest, type LoginRequest, type RegisterRequest, type MeRequest,
} from "../../proto/index.ts";
import { db } from "../../proto/connection.ts";
import { signToken } from "../jwt.ts";
import { requireSession, type Context, type ServiceHandlers } from "../session.ts";
import { uuidv7 } from "../../uuid.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normEmail = (e: string) => e.trim().toLowerCase();

// The public projection of a user row: the identity is the UUIDv7 `uid`, never
// the internal int PK, and never the password hash.
const userView = (u: User) => ({ id: u.uid, email: u.email, username: u.username });

function loadUser(id: number): User {
  const u = db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
  if (!u) throw new ConnectError("user not found", Code.NotFound);
  return u;
}

// Users have an int32 PRIMARY KEY id; allocate the next one (single-writer app,
// so max+1 inside the insert path is fine). The public identity is `uid`.
function nextUserId(): number {
  return db.selectFrom("users").select(["id"]).execute().reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

export const authServiceImpl: ServiceHandlers<typeof AuthService> = {
  async register(req: RegisterRequest) {
    const email = normEmail(req.email);
    const username = req.username.trim();
    if (!EMAIL_RE.test(email)) throw new ConnectError("invalid email", Code.InvalidArgument);
    if (username.length < 1) throw new ConnectError("username is required", Code.InvalidArgument);
    if (req.password.length < 3) throw new ConnectError("password must be at least 3 characters", Code.InvalidArgument);
    if (db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst()) {
      throw new ConnectError("an account with that email already exists", Code.AlreadyExists);
    }
    const id = nextUserId();
    const uid = uuidv7();
    const passwordHash = await Bun.password.hash(req.password, "bcrypt");
    db.insertInto("users").values({ id, uid, email, username, passwordHash }).execute();
    return { token: signToken(uid), user: userView(loadUser(id)) };
  },

  async login(req: LoginRequest) {
    const email = normEmail(req.email);
    const u = db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
    const ok = u ? await Bun.password.verify(req.password, u.passwordHash) : false;
    // One generic message — don't reveal which of email/password was wrong.
    if (!u || !ok) throw new ConnectError("invalid email or password", Code.Unauthenticated);
    return { token: signToken(u.uid), user: userView(u) };
  },

  me(_req: MeRequest, ctx: Context) {
    return { user: userView(loadUser(requireSession(ctx).user.id)) };
  },

  async changePassword(req: ChangePasswordRequest, ctx: Context) {
    const { user } = requireSession(ctx);
    if (req.newPassword.length < 4) throw new ConnectError("password must be at least 4 characters", Code.InvalidArgument);
    const u = loadUser(user.id);
    if (!(await Bun.password.verify(req.currentPassword, u.passwordHash))) {
      throw new ConnectError("current password is incorrect", Code.InvalidArgument);
    }
    const passwordHash = await Bun.password.hash(req.newPassword, "bcrypt");
    db.updateTable("users").set({ passwordHash }).where("id", "=", user.id).execute();
    return {};
  },
};
