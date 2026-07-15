// The app database connection. Opens the DB and reconciles the schema from
// src/proto/models/database.proto; import `db` to read/write.
//
// DB path: resolved by src/config.ts from APP_ENV (data/<env>/db.sqlite3),
// overridable with DB_PATH.

import { Database } from "bun:sqlite";
import { openAppDb } from "./gen/client.gen.ts";
import { DB_PATH } from "../config.ts";

export const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL");

export const db = openAppDb(sqlite);
db.migrate();
