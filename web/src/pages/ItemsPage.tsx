// ItemsPage — the example page. Demonstrates the full read/write loop against an
// owner-scoped RPC service: load on mount (ListItems), create (CreateItem), and
// delete (DeleteItem), re-rendering the list of ItemCards each time. Copy this
// shape for your own resource pages.

import React, { useEffect, useState } from "react";
import { rpc, errMsg } from "../rpc.ts";
import type { Item } from "../proto/index.ts";
import { ItemCard } from "../components/ItemCard.tsx";

export function ItemsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const { items } = await rpc.item.listItems({});
      setItems(items);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await rpc.item.createItem({ name, description });
      setName("");
      setDescription("");
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await rpc.item.deleteItem({ id });
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <div className="page">
      <form className="item-new" onSubmit={create}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? "…" : "Add"}
        </button>
      </form>

      {error && <div className="page-error">{error}</div>}

      {items.length === 0 ? (
        <div className="page-empty">No items yet</div>
      ) : (
        <div className="card-grid">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} onDelete={() => remove(item.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
