// ItemCard — the example card component. Renders one Item (from the generated
// proto type) with a delete control. Presentational: it owns no state and calls
// back to the page for mutations. Copy this shape for your own cards.

import React from "react";
import type { Item } from "../proto/index.ts";

export function ItemCard({ item, onDelete }: { item: Item; onDelete: () => void }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-name">{item.name}</span>
        <button className="card-del" onClick={onDelete} title="Delete">×</button>
      </div>
      {item.description && <p className="card-desc">{item.description}</p>}
    </div>
  );
}
