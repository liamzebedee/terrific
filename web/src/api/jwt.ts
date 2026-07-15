// Minimal HS256 JSON Web Tokens — sign on login/register, verify per request.
//
// No dependency: a JWT is base64url(header).base64url(payload).base64url(sig)
// where sig = HMAC-SHA256(header.payload, secret). The secret comes from
// env.JWT_SECRET (loaded from .env.<env> by src/config.ts). We only need our own
// tokens to round-trip, so HS256 with one shared secret is enough.

import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config.ts";

const DEV_FALLBACK = "dev-insecure-secret-change-me";

function secret(): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is not set — refusing to sign tokens with a fallback in production");
  }
  console.warn("[jwt] JWT_SECRET unset — using an insecure dev fallback. Set it in .env.local");
  return DEV_FALLBACK;
}

const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest("base64url");

// Long-lived by default: the client keeps you signed in ("remember me"), so the
// token has to outlast a browser session. A non-remembered login just parks the
// same token in sessionStorage, which the browser drops at close.
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

export function signToken(userId: string, ttlSec = DEFAULT_TTL_SEC): string {
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: userId, iat: now, exp: now + ttlSec })}`;
  return `${data}.${sign(data)}`;
}

// The user id encoded in a valid, unexpired token, or null if the token is
// malformed, tampered with, or expired.
export function verifyToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = sign(`${header}.${payload}`);
  // Constant-time compare; timingSafeEqual throws on length mismatch.
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof sub !== "string") return null;
    if (typeof exp === "number" && Math.floor(Date.now() / 1000) >= exp) return null;
    return sub;
  } catch {
    return null;
  }
}
