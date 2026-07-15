// GENERATED from src/proto/models/database.proto — do not edit by hand.
// Regenerate:  bun protodatabase/cli.ts src/proto/models/database.proto …
import type { MessageShape, MessageInitShape } from "@bufbuild/protobuf";
import { UserSchema } from ".//models/user_pb.ts";
import { ItemSchema } from ".//models/item_pb.ts";

export interface Schema {
  users: { select: MessageShape<typeof UserSchema>; insert: MessageInitShape<typeof UserSchema> };
  items: { select: MessageShape<typeof ItemSchema>; insert: MessageInitShape<typeof ItemSchema> };
}
