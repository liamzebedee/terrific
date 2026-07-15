// GENERATED from src/proto/models/database.proto — do not edit by hand.
// Regenerate:  bun protodatabase/cli.ts src/proto/models/database.proto …
import type { Database } from "bun:sqlite";
import { createDb, type Db } from "../../../protodatabase/client.ts";
import { DatabaseSchema } from "./database_pb.ts";
import type { Schema } from "./schema.gen.ts";

export type { Schema };
export type AppDb = Db<Schema>;

export function openAppDb(sqlite: Database, onSql?: (sql: string, params: unknown[]) => void): Db<Schema> {
  return createDb<Schema>(sqlite, DatabaseSchema, onSql);
}
