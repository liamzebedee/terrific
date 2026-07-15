// Dev-only: watch src/proto and re-run `buf generate` on change, so proto
// edits hot-regenerate src/proto/gen — Bun --hot then reloads the server and HMR
// rebuilds the client, no extra process or command needed.
//
// Imported by main.ts. Guarded on globalThis so --hot reloads don't stack
// watchers; buf is a devDependency (bun run puts node_modules/.bin on PATH), so
// no nix-shell is needed. Only .proto edits trigger a regen — the generated
// files live under src/proto/gen, so watching for them would loop.

import { watch } from "node:fs";

const KEY = Symbol.for("app.protoWatch");
if (process.env.NODE_ENV !== "production" && !(globalThis as any)[KEY]) {
  (globalThis as any)[KEY] = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch("src/proto", { recursive: true }, (_event, filename) => {
    if (!filename || !filename.toString().endsWith(".proto")) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        // Full regen: `gen` runs buf (emits *_pb.ts messages), then
        // protodatabase (schema.gen + client.gen). buf's `clean` wipes gen/
        // first, so the client.gen/schema.gen files are re-emitted after.
        const proc = Bun.spawn(["bun", "run", "gen"], { stdout: "inherit", stderr: "inherit" });
        if ((await proc.exited) === 0) console.log("Proto change: regenerated src/proto/gen");
        else console.error("gen failed (see above)");
      } catch {
        console.error("Proto changed but regen failed — run `bun run gen` manually to see the error");
      }
    }, 150);
  });
}
