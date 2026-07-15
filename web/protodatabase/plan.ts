// Descriptor → relational plan.
//
// Walks the `Database` message reflectively and derives the physical schema:
// one Table per top-level field, one Column per row-message field. This is the
// single source of truth the client, the migrator and the view generator all
// read from. Nothing here is hand-maintained — change the .proto, regenerate,
// and the plan changes with it.

import { type DescMessage, type DescField, ScalarType } from "@bufbuild/protobuf";

// google.protobuf.FeatureSet.FieldPresence.EXPLICIT — a scalar with explicit
// presence (proto3 `optional`) is nullable; an implicit one carries a default.
const EXPLICIT = 1;

export type ColumnKind = "scalar" | "blob";
export type SqlType = "TEXT" | "REAL" | "INTEGER" | "BLOB";

export interface Column {
  field: DescField;
  name: string; // physical column, e.g. "f2"
  proto: string; // real field name, e.g. "name"
  sqlType: SqlType;
  kind: ColumnKind; // scalar → typed & queryable; blob → raw protobuf bytes
  nullable: boolean;
}

export interface Table {
  proto: string; // Database field name, e.g. "meals"
  name: string; // physical table, e.g. "t1"
  row: DescMessage; // the row message type
  pk?: string; // physical primary-key column (the row's `id`), else rowid
  columns: Column[]; // row-message fields
}

function scalarSqlType(t: ScalarType): SqlType {
  switch (t) {
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return "REAL";
    case ScalarType.STRING:
      return "TEXT";
    case ScalarType.BYTES:
      return "BLOB";
    default:
      return "INTEGER"; // int32/64, uint, fixed, sint, bool
  }
}

function planColumn(field: DescField): Column {
  const name = `f${field.number}`;
  const proto = field.localName;
  if (field.fieldKind === "scalar") {
    return { field, name, proto, sqlType: scalarSqlType(field.scalar), kind: "scalar", nullable: field.presence === EXPLICIT };
  }
  if (field.fieldKind === "enum") {
    return { field, name, proto, sqlType: "INTEGER", kind: "scalar", nullable: field.presence === EXPLICIT };
  }
  // message | list | map → the field's own protobuf encoding, as bytes.
  return { field, name, proto, sqlType: "BLOB", kind: "blob", nullable: true };
}

// A row's primary key is its `id` (or `key`) field, if it has one; otherwise
// the table is keyed by SQLite's implicit rowid.
function pkColumn(row: DescMessage): string | undefined {
  const pk = row.fields.find((f) => (f.localName === "id" || f.localName === "key") && f.fieldKind === "scalar");
  return pk ? `f${pk.number}` : undefined;
}

// The one rule: every Database field is `repeated <Message>`. A table is a set
// of rows, so nothing else is a table — not a map, not a singular message.
export function planTable(field: DescField): Table {
  const proto = field.localName;
  if (field.fieldKind !== "list" || field.listKind !== "message") {
    const got = field.fieldKind === "list" ? `repeated ${field.listKind}` : field.fieldKind;
    throw new Error(`Database.${proto}: every table must be 'repeated <Message>' (a table is a set of rows); got ${got}`);
  }
  const row = field.message;
  return { proto, name: `t${field.number}`, row, pk: pkColumn(row), columns: row.fields.map(planColumn) };
}

export function planDatabase(schema: DescMessage): Table[] {
  return schema.fields.map(planTable);
}

// --- DDL -------------------------------------------------------------------

export function createTableSql(t: Table): string {
  const lines = t.columns.map((c) => ({
    code: `${c.name} ${c.sqlType}${c.name === t.pk ? " PRIMARY KEY" : ""}`,
    note: c.kind === "blob" ? `${c.proto} (bytes)` : c.proto,
  }));
  const width = Math.max(...lines.map((l) => l.code.length));
  const body = lines
    .map((l, i) => `  ${(l.code + (i < lines.length - 1 ? "," : "")).padEnd(width + 2)}-- ${l.note}`)
    .join("\n");
  return `CREATE TABLE IF NOT EXISTS ${t.name} (   -- ${t.proto}\n${body}\n)`;
}

// A view over the physical table that restores the real proto names, so the
// database is legible from a plain sqlite3 shell despite the fN columns.
export function createViewSql(t: Table): string {
  const body = t.columns
    .map((c, i) => `  ${c.name} AS "${c.proto}"${i < t.columns.length - 1 ? "," : ""}`)
    .join("\n");
  return `CREATE VIEW IF NOT EXISTS "${t.proto}" AS\nSELECT\n${body}\nFROM ${t.name}`;
}
