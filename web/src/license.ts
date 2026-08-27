// License minting + storage.
//
// A license key is `<b64url(payload)>.<b64url(sig)>`, where `sig` is an Ed25519
// signature over the ASCII bytes of the base64 payload. `payload` is small
// JSON: {"name","email","issued":"YYYY-MM-DD","product":"termset"}. The termset
// app verifies this offline against the compiled-in public key
// (`scripts/license-pubkey.bin`) — see `src/license.rs`. This module holds the
// PRIVATE key and does the signing.
//
// Keys are also persisted (one row per Stripe Checkout session) so the success
// page can look one up without re-deriving it, and so support can re-issue.

import { createPrivateKey, sign } from "node:crypto";
import { sqlite } from "./proto/connection.ts";

const PRODUCT = "termset";

// One-time schema setup for the licenses table (idempotent). Kept out of the
// protobuf-generated schema on purpose: licenses are backend-only billing
// state, not part of the app's data model.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    session_id  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    license_key TEXT NOT NULL,
    issued      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  )
`);

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function privateKeyObject() {
  const b64 = process.env.LICENSE_PRIVKEY_B64;
  if (!b64) {
    throw new Error("LICENSE_PRIVKEY_B64 is not set — run scripts/gen-license-keypair.ts");
  }
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

// Sign a license key for a buyer. Deterministic given the same inputs (Ed25519
// signatures are deterministic), so re-minting the same (name,email,issued)
// yields the byte-identical key.
export function mintLicenseKey(input: { name: string; email: string; issued: string }): string {
  const payload = JSON.stringify({
    name: input.name,
    email: input.email,
    issued: input.issued,
    product: PRODUCT,
  });
  const payloadB64 = b64url(Buffer.from(payload, "utf8"));
  const sig = sign(null, Buffer.from(payloadB64, "utf8"), privateKeyObject());
  return `${payloadB64}.${b64url(sig)}`;
}

// Mint (or re-return) the license for a Stripe Checkout session and persist it.
// Idempotent: the same session id always yields the same stored key, so a
// retried webhook never issues a second key.
export function issueForSession(input: {
  sessionId: string;
  email: string;
  name: string;
  createdUnix: number;
}): { licenseKey: string; issued: string } {
  const existing = sqlite
    .query<{ license_key: string; issued: string }, [string]>(
      "SELECT license_key, issued FROM licenses WHERE session_id = ?",
    )
    .get(input.sessionId);
  if (existing) return { licenseKey: existing.license_key, issued: existing.issued };

  const issued = new Date(input.createdUnix * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const licenseKey = mintLicenseKey({ name: input.name, email: input.email, issued });
  sqlite.run(
    "INSERT INTO licenses (session_id, email, name, license_key, issued, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.sessionId, input.email, input.name, licenseKey, issued, input.createdUnix],
  );
  return { licenseKey, issued };
}

// Look up a previously issued license by Checkout session id (for the success
// page). Returns null until the webhook has processed the payment.
export function licenseForSession(sessionId: string): { licenseKey: string; email: string } | null {
  const row = sqlite
    .query<{ license_key: string; email: string }, [string]>(
      "SELECT license_key, email FROM licenses WHERE session_id = ?",
    )
    .get(sessionId);
  return row ? { licenseKey: row.license_key, email: row.email } : null;
}
