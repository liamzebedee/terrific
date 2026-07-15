// Code generation, as pure functions of a `Database` descriptor. The CLI
// (cli.ts) wires these to protoc and the filesystem; keeping them pure makes
// them easy to test and reuse.

import { type DescMessage } from "@bufbuild/protobuf";
import { planDatabase, createTableSql, createViewSql } from "./plan.ts";

const header = (proto: string) => [
  `// GENERATED from ${proto} — do not edit by hand.`,
  `// Regenerate:  bun protodatabase/cli.ts ${proto} …`,
];

// The raw DDL — one CREATE TABLE + CREATE VIEW per table.
export function schemaSql(dbSchema: DescMessage, protoPath: string): string {
  const out = [`-- GENERATED from ${protoPath} — do not edit by hand.`, ""];
  for (const t of planDatabase(dbSchema)) {
    out.push(createTableSql(t) + ";", createViewSql(t) + ";", "");
  }
  return out.join("\n");
}

// The Kysely-style `Schema` type: table → { select, insert } row types, pulled
// straight from the protobuf message types. `genBase` is the import path (from
// the emitted file) to the directory holding the generated *_pb.ts.
export function dbTypes(dbSchema: DescMessage, protoPath: string, genBase: string): string {
  const tables = planDatabase(dbSchema);
  const byModule = new Map<string, Set<string>>();
  for (const t of tables) {
    const mod = `${genBase}/${t.row.file.name}_pb.ts`;
    if (!byModule.has(mod)) byModule.set(mod, new Set());
    byModule.get(mod)!.add(`${t.row.name}Schema`);
  }
  const imports = [...byModule].map(([mod, names]) => `import { ${[...names].sort().join(", ")} } from "${mod}";`);
  const rows = tables.map((t) => {
    const s = `typeof ${t.row.name}Schema`;
    return `  ${t.proto}: { select: MessageShape<${s}>; insert: MessageInitShape<${s}> };`;
  });
  return [
    ...header(protoPath),
    `import type { MessageShape, MessageInitShape } from "@bufbuild/protobuf";`,
    ...imports,
    "",
    "export interface Schema {",
    ...rows,
    "}",
    "",
  ].join("\n");
}

// The ready-to-use client module: an `open<Name>` that binds the framework
// `createDb` to this database's descriptor and `Schema` type.
export function clientModule(
  dbSchema: DescMessage,
  protoPath: string,
  opts: { openName: string; frameworkImport: string; schemaModule: string; schemaExport: string; typesImport: string },
): string {
  const typeName = (opts.openName.startsWith("open") ? opts.openName.slice(4) : opts.openName + "Db") || "PlannerDb";
  return [
    ...header(protoPath),
    `import type { Database } from "bun:sqlite";`,
    `import { createDb, type Db } from "${opts.frameworkImport}";`,
    `import { ${opts.schemaExport} } from "${opts.schemaModule}";`,
    `import type { Schema } from "${opts.typesImport}";`,
    "",
    `export type { Schema };`,
    `export type ${typeName} = Db<Schema>;`,
    "",
    `export function ${opts.openName}(sqlite: Database, onSql?: (sql: string, params: unknown[]) => void): Db<Schema> {`,
    `  return createDb<Schema>(sqlite, ${opts.schemaExport}, onSql);`,
    `}`,
    "",
  ].join("\n");
}
