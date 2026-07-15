// Emit schema.sql from the proto definitions:  bun protodatabase/codegen.ts
//
// The raw DDL that `message Database` compiles to — one CREATE TABLE + one
// CREATE VIEW per table. This is what ProtoDB.migrate() converges the live
// database toward; writing it to a file makes the generated schema reviewable
// in a diff and runnable with a plain `sqlite3 db < schema.sql`.

import { DatabaseSchema } from "./gen/db/v1/database_pb.ts";
import { planDatabase, createTableSql, createViewSql } from "./plan.ts";

export function schemaSql(): string {
  const out: string[] = [
    "-- GENERATED from proto/db/v1/database.proto — do not edit by hand.",
    "-- Regenerate:  bun protodatabase/codegen.ts",
    "",
  ];
  for (const t of planDatabase(DatabaseSchema)) {
    out.push(createTableSql(t) + ";");
    out.push(createViewSql(t) + ";");
    out.push("");
  }
  return out.join("\n");
}

// The Kysely-style `Schema` interface: table name → { select, insert } row
// types, pulled straight from the protobuf-es message types so nested fields
// keep their real proto types (not bytes). Map tables gain a `key` column.
export function dbTypes(): string {
  const tables = planDatabase(DatabaseSchema);
  const byModule = new Map<string, Set<string>>();
  for (const t of tables) {
    const mod = `./gen/${t.row.file.name}_pb.ts`;
    const set = byModule.get(mod) ?? new Set<string>();
    set.add(`${t.row.name}Schema`);
    byModule.set(mod, set);
  }
  const imports = [...byModule].map(([mod, names]) => `import { ${[...names].sort().join(", ")} } from "${mod}";`);
  const rows = tables.map((t) => {
    const s = `typeof ${t.row.name}Schema`;
    return `  ${t.proto}: { select: MessageShape<${s}>; insert: MessageInitShape<${s}> };`;
  });
  return [
    "// GENERATED from proto/db/v1/database.proto — do not edit by hand.",
    "// Regenerate:  bun protodatabase/codegen.ts",
    `import type { MessageShape, MessageInitShape } from "@bufbuild/protobuf";`,
    ...imports,
    "",
    "export interface Schema {",
    ...rows,
    "}",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const sql = new URL("./schema.sql", import.meta.url).pathname;
  const types = new URL("./db.gen.ts", import.meta.url).pathname;
  await Bun.write(sql, schemaSql());
  await Bun.write(types, dbTypes());
  console.log(`wrote ${sql}`);
  console.log(`wrote ${types}`);
}
