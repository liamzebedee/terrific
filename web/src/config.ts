// Typed runtime configuration. The app runs in one of two environments —
// `local` (the default) or `prod` — selected by APP_ENV. On import this loads
// the matching .env.<env> file, then validates the environment into a typed
// `env` object. Import it before anything that reads config or opens the DB.
//
// Each .env.<env> sets DB_PATH (data/<env>/db.sqlite3) — DB_PATH is what selects
// the database the app opens. .env.local is committed as the dev default; every
// other .env file is gitignored.
//
// Bun auto-loads .env.local in EVERY environment (and at higher precedence than
// .env.production), so its values leak into prod. We own loading here: parse the
// selected file ourselves and, when we're not the local env, scrub any key whose
// current value is verbatim from .env.local (a Bun auto-load leak, not a genuine
// inline override) before applying the selected file.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AppEnv = "local" | "prod";

export interface Env {
  readonly APP_ENV: AppEnv;
  readonly DB_PATH: string;
  readonly PORT: number;
  readonly JWT_SECRET?: string;
  readonly NODE_ENV?: string;
}

export const APP_ENV: AppEnv = process.env.APP_ENV === "prod" ? "prod" : "local";

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Drop keys that Bun auto-loaded from .env.local when we're a different env: a
// key still equal to its .env.local value is a leak; a differing value is a
// genuine inline override and is kept.
if (APP_ENV !== "local") {
  for (const [key, value] of Object.entries(parseEnvFile(join(process.cwd(), ".env.local")))) {
    if (process.env[key] === value) delete process.env[key];
  }
}

// Apply the selected file without clobbering genuine inline env (tests set
// DB_PATH=":memory:"), which now always wins.
for (const [key, value] of Object.entries(parseEnvFile(join(process.cwd(), `.env.${APP_ENV}`)))) {
  if (!(key in process.env)) process.env[key] = value;
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`PORT must be a positive integer (got "${value}")`);
  return n;
}

export const env: Env = {
  APP_ENV,
  // DB_PATH selects the database; each .env.<env> points it at data/<env>/. The
  // fallback keeps tests (DB_PATH=":memory:") and fresh checkouts working.
  DB_PATH: process.env.DB_PATH ?? join("data", APP_ENV, "db.sqlite3"),
  PORT: port(process.env.PORT, 3001),
  JWT_SECRET: process.env.JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV,
};

// Ensure the database's directory exists (skip the in-memory test DB).
if (env.DB_PATH !== ":memory:") mkdirSync(dirname(env.DB_PATH), { recursive: true });

export const { DB_PATH, PORT } = env;
