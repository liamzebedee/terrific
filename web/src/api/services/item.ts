// app.v1.ItemService — owner-scoped CRUD over the example `items` table.
//
// The reference example of an authenticated resource service: every method
// calls requireSession(ctx) and scopes its query with `.where("owner", ...)`,
// so a user only ever sees or mutates their own rows. Copy this shape for real
// resources; swap the Item table for yours.

import { Code, ConnectError } from "@connectrpc/connect";
import {
  ItemService,
  type CreateItemRequest, type DeleteItemRequest, type ListItemsRequest,
} from "../../proto/index.ts";
import { db } from "../../proto/connection.ts";
import { requireSession, type Context, type ServiceHandlers } from "../session.ts";
import { uuidv7 } from "../../uuid.ts";

export const itemServiceImpl: ServiceHandlers<typeof ItemService> = {
  listItems(_req: ListItemsRequest, ctx: Context) {
    const owner = requireSession(ctx).user.id;
    const items = db.selectFrom("items").selectAll().where("owner", "=", owner).execute();
    // Newest first.
    items.sort((a, b) => b.createdAt - a.createdAt);
    return { items };
  },

  createItem(req: CreateItemRequest, ctx: Context) {
    const owner = requireSession(ctx).user.id;
    const name = req.name.trim();
    if (!name) throw new ConnectError("name is required", Code.InvalidArgument);
    const item = {
      id: uuidv7(), owner, name, description: req.description.trim(), createdAt: Date.now(),
    };
    db.insertInto("items").values(item).execute();
    return { item };
  },

  deleteItem(req: DeleteItemRequest, ctx: Context) {
    const owner = requireSession(ctx).user.id;
    // Scope the delete to the owner so one user can't delete another's row.
    db.deleteFrom("items").where("id", "=", req.id).where("owner", "=", owner).execute();
    return {};
  },
};
