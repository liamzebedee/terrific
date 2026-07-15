// The client — a Kysely-style typed query builder over the proto schema.
//
//   const db = createDb(new Database("data.sqlite3"));
//   db.insertInto("meals").values({ id: "m1", name: "lunch" }).execute();
//   db.selectFrom("meals").selectAll().where("name", "=", "lunch").execute();
//   db.updateTable("nutrition").set({ gi: 70 }).where("key", "=", "rice").execute();
//   db.deleteFrom("meals").where("id", "=", "m2").execute();
//
// Table and column names, and every value, are typed from the generated
// `Schema` (db.gen.ts) — which draws its row types straight from the protobuf
// messages, so nested fields keep their real proto types. Under the hood the
// builder maps field names → fN columns, keeps scalars as typed columns you can
// filter on, and stores everything else as protobuf bytes. Equality-style
// filters only; for anything richer, query the generated views in real SQL.

import { Database } from "bun:sqlite";
import { create, toBinary, fromBinary, ScalarType, type DescMessage } from "@bufbuild/protobuf";
import { planDatabase, createTableSql, createViewSql, type Table, type Column } from "./plan.ts";

// One table's row types in a generated `Schema` (db.gen.ts). The generic bound
// below is written as a mapped type, not `Record<string, TableDef>`, so a plain
// `interface Schema { … }` satisfies it (interfaces lack an index signature).
export type TableDef = { select: unknown; insert: unknown };
export type SchemaShape = { [table: string]: TableDef };

type Row = Record<string, unknown>;
export type Op = "=" | "!=" | "<" | "<=" | ">" | ">=";
interface Cond {
  col: string;
  op: Op;
  val: unknown;
}

export interface MigrationAction {
  kind: "create-table" | "add-column";
  table: string;
  detail: string;
}

const isBool = (c: Column) => c.kind === "scalar" && c.field.fieldKind === "scalar" && c.field.scalar === ScalarType.BOOL;

// --- proto value ⇄ column value --------------------------------------------

// One field's stored column value, off an already-created message.
function encodeColumn(t: Table, msg: Row, c: Column): unknown {
  const v = msg[c.proto];
  if (c.kind === "scalar") return v === undefined ? null : isBool(c) ? (v ? 1 : 0) : (v as never);
  return toBinary(t.row, create(t.row, { [c.proto]: v } as never)); // just this field → bytes
}

// A physical row → a reconstructed proto message.
function decodeRow(t: Table, row: Row, only?: Set<string>): Row {
  const init: Row = {};
  for (const c of t.columns) {
    if (only && !only.has(c.proto)) continue;
    const v = row[c.name];
    if (v === null || v === undefined) continue;
    if (c.kind === "scalar") init[c.proto] = isBool(c) ? Boolean(v) : v;
    else {
      const decoded = fromBinary(t.row, v as Uint8Array) as Row;
      if (decoded[c.proto] !== undefined) init[c.proto] = decoded[c.proto];
    }
  }
  return create(t.row, init as never) as Row;
}

// {field: value} filter → WHERE over fN columns. Scalars only; blobs are opaque.
function compileWhere(t: Table, conds: Cond[]): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const { col, op, val } of conds) {
    const c = t.columns.find((c) => c.proto === col);
    if (!c) throw new Error(`${t.proto}: no column for field "${col}"`);
    if (c.kind !== "scalar") throw new Error(`${t.proto}.${col} is a ${c.sqlType} (nested) column; not filterable`);
    clauses.push(`${c.name} ${op} ?`);
    params.push(isBool(c) ? (val ? 1 : 0) : val);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

// --- fluent builders --------------------------------------------------------

interface Ctx {
  db: Database;
  t: Table;
  onSql?: (sql: string, params: unknown[]) => void;
}
function run(ctx: Ctx, sql: string, params: unknown[]) {
  ctx.onSql?.(sql, params);
  return ctx.db.prepare(sql).run(...(params as never[]));
}

class SelectBuilder<R> {
  private cols?: string[];
  private conds: Cond[] = [];
  constructor(private ctx: Ctx) {}
  selectAll(): SelectBuilder<R> {
    this.cols = undefined;
    return this;
  }
  select<C extends keyof R & string>(cols: C[]): SelectBuilder<Pick<R, C>> {
    this.cols = cols as string[];
    return this as unknown as SelectBuilder<Pick<R, C>>;
  }
  where<F extends keyof R & string>(field: F, op: Op, value: R[F]): this {
    this.conds.push({ col: field, op, val: value });
    return this;
  }
  execute(): R[] {
    const { t } = this.ctx;
    const w = compileWhere(t, this.conds);
    const sql = `SELECT * FROM ${t.name}${w.sql}`;
    this.ctx.onSql?.(sql, w.params);
    const rows = this.ctx.db.query(sql).all(...(w.params as never[])) as Row[];
    const only = this.cols ? new Set(this.cols) : undefined;
    return rows.map((r) => decodeRow(t, r, only)) as R[];
  }
  executeTakeFirst(): R | undefined {
    return this.execute()[0];
  }
  executeTakeFirstOrThrow(): R {
    const r = this.executeTakeFirst();
    if (r === undefined) throw new Error(`${this.ctx.t.proto}: no row found`);
    return r;
  }
}

class InsertBuilder<I> {
  private rows: Row[] = [];
  constructor(private ctx: Ctx) {}
  values(v: I | I[]): this {
    this.rows.push(...(Array.isArray(v) ? (v as Row[]) : [v as Row]));
    return this;
  }
  execute(): void {
    const { t } = this.ctx;
    for (const input of this.rows) {
      const msg = create(t.row, input as never) as Row;
      const cols: Record<string, unknown> = {};
      for (const c of t.columns) cols[c.name] = encodeColumn(t, msg, c);
      const names = Object.keys(cols);
      const placeholders = names.map(() => "?").join(", ");
      // Upsert on the `id` primary key; keyless (rowid) tables just append.
      const updates = names.filter((n) => n !== t.pk).map((n) => `${n} = excluded.${n}`);
      const onConflict = t.pk
        ? ` ON CONFLICT(${t.pk}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`
        : "";
      run(this.ctx, `INSERT INTO ${t.name} (${names.join(", ")}) VALUES (${placeholders})${onConflict}`, names.map((n) => cols[n]));
    }
  }
}

class UpdateBuilder<R, I> {
  private assignments: Row = {};
  private conds: Cond[] = [];
  constructor(private ctx: Ctx) {}
  set(patch: Partial<I>): this {
    Object.assign(this.assignments, patch);
    return this;
  }
  where<F extends keyof R & string>(field: F, op: Op, value: R[F]): this {
    this.conds.push({ col: field, op, val: value });
    return this;
  }
  execute(): void {
    const { t } = this.ctx;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [proto, value] of Object.entries(this.assignments)) {
      if (proto.startsWith("$")) continue; // message internals ($typeName), when a whole message is passed to set()
      const c = t.columns.find((c) => c.proto === proto);
      if (!c) throw new Error(`${t.proto}: no column for field "${proto}"`);
      const msg = create(t.row, { [proto]: value } as never) as Row;
      sets.push(`${c.name} = ?`);
      params.push(encodeColumn(t, msg, c));
    }
    if (!sets.length) return;
    const w = compileWhere(t, this.conds);
    run(this.ctx, `UPDATE ${t.name} SET ${sets.join(", ")}${w.sql}`, [...params, ...w.params]);
  }
}

class DeleteBuilder<R> {
  private conds: Cond[] = [];
  constructor(private ctx: Ctx) {}
  where<F extends keyof R & string>(field: F, op: Op, value: R[F]): this {
    this.conds.push({ col: field, op, val: value });
    return this;
  }
  execute(): void {
    const { t } = this.ctx;
    const w = compileWhere(t, this.conds);
    run(this.ctx, `DELETE FROM ${t.name}${w.sql}`, w.params);
  }
}

// --- the database -----------------------------------------------------------

export class Db<S extends { [K in keyof S]: TableDef }> {
  readonly tables: Map<string, Table>;
  constructor(
    private db: Database,
    dbSchema: DescMessage,
    private onSql?: (sql: string, params: unknown[]) => void,
  ) {
    this.tables = new Map(planDatabase(dbSchema).map((t) => [t.proto, t]));
  }

  private ctx(table: string): Ctx {
    const t = this.tables.get(table);
    if (!t) throw new Error(`no such table: ${table}`);
    return { db: this.db, t, onSql: this.onSql };
  }

  selectFrom<K extends keyof S & string>(table: K): SelectBuilder<S[K]["select"]> {
    return new SelectBuilder(this.ctx(table));
  }
  insertInto<K extends keyof S & string>(table: K): InsertBuilder<S[K]["insert"]> {
    return new InsertBuilder(this.ctx(table));
  }
  updateTable<K extends keyof S & string>(table: K): UpdateBuilder<S[K]["select"], S[K]["insert"]> {
    return new UpdateBuilder(this.ctx(table));
  }
  deleteFrom<K extends keyof S & string>(table: K): DeleteBuilder<S[K]["select"]> {
    return new DeleteBuilder(this.ctx(table));
  }

  // Run writes atomically. Use for a multi-statement replace (delete + insert).
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // Additive schema reconcile: new table → CREATE, new field → ADD COLUMN.
  // Idempotent, so there is no migration ledger — "done" is read off the DB.
  migrate(): MigrationAction[] {
    const actions: MigrationAction[] = [];
    for (const t of this.tables.values()) {
      const existing = new Set(
        (this.db.query(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name),
      );
      if (existing.size === 0) {
        this.db.exec(createTableSql(t));
        actions.push({ kind: "create-table", table: t.name, detail: t.proto });
      } else {
        for (const c of t.columns) {
          if (!existing.has(c.name)) {
            this.db.exec(`ALTER TABLE ${t.name} ADD COLUMN ${c.name} ${c.sqlType}`);
            actions.push({ kind: "add-column", table: t.name, detail: `${c.name} (${c.proto}) ${c.sqlType}` });
          }
        }
      }
      this.db.exec(createViewSql(t));
    }
    return actions;
  }
}

export function createDb<S extends { [K in keyof S]: TableDef }>(
  sqlite: Database,
  dbSchema: DescMessage,
  onSql?: (sql: string, params: unknown[]) => void,
): Db<S> {
  return new Db<S>(sqlite, dbSchema, onSql);
}
