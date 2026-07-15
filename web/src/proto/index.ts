// Barrel for the generated app.v1 API — one import site for every message,
// schema, and service, so callers never track which .proto a type lives in.
//
// The protos are split by concern (models/, services/) and buf emits one
// message file per proto under gen/. This re-exports them as a flat surface.
// Each models/*.proto message IS a database table; the storage schema is
// assembled in models/database.proto and generated separately by protodatabase
// (bun run gen:db) into gen/ (schema.gen.*, client.gen) — import the app
// client/connection from src/proto/gen and src/proto, not here. The Database
// registry itself is plumbing and deliberately not exported.

export * from "./gen/models/user_pb.ts";
export * from "./gen/models/item_pb.ts";

export * from "./gen/services/auth_pb.ts";
export * from "./gen/services/item_pb.ts";
export * from "./gen/services/test_pb.ts";
