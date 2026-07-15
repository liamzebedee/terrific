// Runnable demo:  bun protodatabase/demo.ts
//
// The Kysely-style client, driven by the all-`repeated` `Database` proto. Every
// table is a set of rows; a keyed table (nutrition) is just a row with a `key`
// column. Writes real planner data and reads it back, printing the field-name →
// fN-column translation the builder performs.

import { Database } from "bun:sqlite";
import { createDb } from "./client.ts";
import { planDatabase } from "./plan.ts";
import { DatabaseSchema } from "./gen/db/v1/database_pb.ts";
import type { Schema } from "./db.gen.ts";

const line = (s = "") => console.log(s);
const rule = (t: string) => line(`\n\x1b[1m━━ ${t} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
function show(v: unknown): unknown {
  if (v instanceof Uint8Array) return `<${v.length}b>`;
  return v;
}
const j = (r: unknown) => JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? show(v) : v));

// ── Schema ──────────────────────────────────────────────────────────────────
rule("SCHEMA  (every Database field = repeated rows)");
for (const t of planDatabase(DatabaseSchema)) {
  const cols = t.columns.map((c) => `${c.name}=${c.proto}${c.kind === "blob" ? "*" : ""}`).join("  ");
  line(`\x1b[36m${t.proto.padEnd(11)}\x1b[0m ${t.name}  pk=${t.pk ?? "rowid"}   ${cols}  \x1b[2m(*=bytes)\x1b[0m`);
}

// ── Open + migrate ──────────────────────────────────────────────────────────
const sqlLog: string[] = [];
const db = createDb<Schema>(new Database(":memory:"), DatabaseSchema, (sql, p) => sqlLog.push(`${sql}   ${j(p)}`));
rule("MIGRATE");
for (const a of db.migrate()) line(`  + ${a.table}  ${a.detail}`);
line(`  again → ${db.migrate().length} actions (idempotent)`);

// ── Insert ──────────────────────────────────────────────────────────────────
rule("db.insertInto(table).values(row).execute()");
db.insertInto("meals").values([
  { id: "m1", name: "lunch", ingredients: "200g chicken\n100g rice" },
  { id: "m2", name: "breakfast", ingredients: "oats", list: "archived" },
]).execute();
db.insertInto("nutrition").values({ key: "chicken", macros: { protein: 31, fat: 3.6, carb: 0, energy: 165, dataSource: "afcd" } }).execute();
db.insertInto("profile").values({ user: { age: 30, weightKg: 75, sex: "male" }, proteinDiv: 5, fatDiv: 500 }).execute();
db.insertInto("daysim").values({
  slots: [{ items: [{ type: "meal", mealId: "m1" }] }],
  wake: 420, bed: 1380, startBg: 6.5, bolusRatio: 5, meals: { 0: { min: 480 } },
}).execute();
line(`  last SQL → ${sqlLog.at(-1)}`);

// ── Select / where → fN ─────────────────────────────────────────────────────
rule("db.selectFrom(table).selectAll().where(field, op, value)");
sqlLog.length = 0;
const lunch = db.selectFrom("meals").selectAll().where("name", "=", "lunch").execute();
const chicken = db.selectFrom("nutrition").selectAll().where("key", "=", "chicken").executeTakeFirstOrThrow();
for (const s of sqlLog) line(`  SQL  ${s}`);
line(`  meals where name=lunch → ${lunch.map(j).join(", ")}`);
line(`  nutrition[chicken].macros (from BLOB) → ${j(chicken.macros)}`);

// ── One-row (rowid) tables ──────────────────────────────────────────────────
rule("rowid tables — one row, read with executeTakeFirst");
const ds = db.selectFrom("daysim").selectAll().executeTakeFirstOrThrow();
line(`  daysim.slots → ${j(ds.slots)}   bolusRatio=${ds.bolusRatio}  correctionRatio=${ds.correctionRatio ?? "NULL"}`);
const prof = db.selectFrom("profile").selectAll().executeTakeFirstOrThrow();
line(`  profile.user → ${j(prof.user)}   proteinDiv=${prof.proteinDiv}`);

// ── Update / delete ─────────────────────────────────────────────────────────
rule("db.updateTable / db.deleteFrom");
sqlLog.length = 0;
db.updateTable("meals").set({ ingredients: "500g chicken" }).where("id", "=", "m1").execute();
db.deleteFrom("meals").where("id", "=", "m2").execute();
for (const s of sqlLog) line(`  SQL  ${s}`);
line(`  meals now → ${db.selectFrom("meals").selectAll().execute().map((m) => `${m.id}:${m.ingredients}`).join(", ")}`);
line();
