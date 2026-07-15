// GENERATED from proto/db/v1/database.proto — do not edit by hand.
// Regenerate:  bun protodatabase/codegen.ts
import type { MessageShape, MessageInitShape } from "@bufbuild/protobuf";
import { DaySimSchema, MealSchema, ProfileSchema } from "./gen/planner/v1/planner_pb.ts";
import { NutritionRowSchema, SettingsSchema } from "./gen/db/v1/database_pb.ts";

export interface Schema {
  meals: { select: MessageShape<typeof MealSchema>; insert: MessageInitShape<typeof MealSchema> };
  nutrition: { select: MessageShape<typeof NutritionRowSchema>; insert: MessageInitShape<typeof NutritionRowSchema> };
  profile: { select: MessageShape<typeof ProfileSchema>; insert: MessageInitShape<typeof ProfileSchema> };
  daysim: { select: MessageShape<typeof DaySimSchema>; insert: MessageInitShape<typeof DaySimSchema> };
  settings: { select: MessageShape<typeof SettingsSchema>; insert: MessageInitShape<typeof SettingsSchema> };
}
