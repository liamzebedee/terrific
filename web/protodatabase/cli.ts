#!/usr/bin/env bun
// protodatabase — generate a SQLite schema + a typed client from a `Database`
// proto (see README). You choose every output path; the tool only fills them:
//
//   bun protodatabase/cli.ts <database.proto> \
//       --gen-dir    src/proto/gen \
//       --schema-out src/proto/gen/schema.gen.sql \
//       --types-out  src/proto/gen/schema.gen.ts \
//       --client-out src/proto/gen/client.ts \
//       [--message Database] [--open-name openPlannerDb] [--proto-path <dir>]...
//
//   --gen-dir     where protoc-gen-es writes the *_pb.ts messages
//   --schema-out  raw CREATE TABLE / CREATE VIEW DDL
//   --types-out   the `Schema` type (table → row types)
//   --client-out  the module exporting open…(sqlite) → typed client

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, basename, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { schemaSql, dbTypes, clientModule } from "./generate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const protoPaths: string[] = [];
  const o: Record<string, string> = { message: "Database" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proto-path" || a === "-I") protoPaths.push(argv[++i]);
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  const proto = positional[0];
  const missing = ["gen-dir", "schema-out", "types-out", "client-out"].filter((k) => !o[k]);
  if (!proto || missing.length) {
    console.error(
      "usage: bun protodatabase/cli.ts <database.proto> --gen-dir <dir> --schema-out <file> --types-out <file> --client-out <file> [--message Database] [--open-name name] [--proto-path <dir>]...",
    );
    if (proto) console.error(`missing: ${missing.map((m) => "--" + m).join(", ")}`);
    process.exit(2);
  }
  return {
    proto: resolve(proto),
    genDir: resolve(o["gen-dir"]),
    schemaOut: resolve(o["schema-out"]),
    typesOut: resolve(o["types-out"]),
    clientOut: resolve(o["client-out"]),
    message: o.message,
    openName: o["open-name"] || `open${cap(camel(basename(o["client-out"]).replace(/\.[^.]+$/, "")))}`,
    protoPaths: protoPaths.map((p) => resolve(p)),
  };
}

// All transitively-imported `.proto`s, resolved against the include roots — a
// row proto may import a model that imports a shared-types file, so we walk the
// import graph, not just the target's direct imports. Google well-known types
// are provided by protoc/protobuf-es and never generated.
function transitiveImports(protoAbs: string, roots: string[]): { root: string; rel: string }[] {
  const seen = new Set<string>();
  const out: { root: string; rel: string }[] = [];
  const visit = (abs: string) => {
    const text = readFileSync(abs, "utf8");
    const rels = [...text.matchAll(/^\s*import\s+"([^"]+)"\s*;/gm)].map((m) => m[1]).filter((r) => !r.startsWith("google/"));
    for (const rel of rels) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const root = roots.find((r) => existsSync(join(r, rel)));
      if (!root) throw new Error(`cannot resolve import "${rel}" against: ${roots.join(", ")}`);
      out.push({ root, rel });
      visit(join(root, rel));
    }
  };
  visit(protoAbs);
  return out;
}

function runProtoc(genDir: string, roots: string[], files: { rel: string }[]) {
  const plugin = join(HERE, "..", "node_modules", ".bin", "protoc-gen-es");
  const args = [
    `--plugin=protoc-gen-es=${plugin}`,
    `--es_out=${genDir}`,
    "--es_opt=target=ts",
    ...roots.flatMap((r) => ["-I", r]),
    ...files.map((f) => f.rel),
  ];
  const res = Bun.spawnSync(["protoc", ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`protoc failed (exit ${res.exitCode}):\n${res.stderr.toString() || res.stdout.toString()}`);
}

// A relative ES import specifier from one file to another (keeping the .ts).
function imp(fromFile: string, toFile: string): string {
  let r = relative(dirname(fromFile), toFile).replace(/\\/g, "/");
  return r.startsWith(".") ? r : "./" + r;
}
function camel(s: string) {
  return s.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const a = parseArgs(process.argv.slice(2));
const roots = [dirname(a.proto), ...a.protoPaths];
mkdirSync(a.genDir, { recursive: true });

// 1. protoc: the target proto + its (non-google) imports → *_pb.ts
const target = { rel: basename(a.proto) };
runProtoc(a.genDir, roots, [target, ...transitiveImports(a.proto, roots)]);

// 2. Reflect: load the generated target module and grab the Database descriptor.
const targetPb = join(a.genDir, basename(a.proto).replace(/\.proto$/, "_pb.ts"));
const mod = await import(pathToFileURL(targetPb).href);
const schema = mod[`${a.message}Schema`];
if (!schema?.fields) throw new Error(`${a.message}Schema not found in ${targetPb} — is there a 'message ${a.message}' in ${a.proto}?`);

// 3. Emit the three files at the paths you chose.
const protoRel = relative(process.cwd(), a.proto);
const write = (p: string, s: string) => {
  Bun.write(p, s);
  console.log(`  ${relative(process.cwd(), p)}`);
};
console.log(`generated from ${protoRel}:`);
write(a.schemaOut, schemaSql(schema, protoRel));
write(a.typesOut, dbTypes(schema, protoRel, imp(a.typesOut, a.genDir)));
write(
  a.clientOut,
  clientModule(schema, protoRel, {
    openName: a.openName,
    frameworkImport: imp(a.clientOut, join(HERE, "client.ts")),
    schemaModule: imp(a.clientOut, join(a.genDir, `${schema.file.name}_pb.ts`)),
    typesImport: imp(a.clientOut, a.typesOut),
    schemaExport: `${a.message}Schema`,
  }),
);
console.log(`  → ${a.openName}(sqlite) ready`);
