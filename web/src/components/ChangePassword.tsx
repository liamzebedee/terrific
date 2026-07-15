// Change-password form for the Settings → Account section. Self-contained: it
// owns its fields and status so Settings doesn't have to thread the state.

import React, { useState } from "react";
import { session } from "../session.ts";
import { errMsg } from "../rpc.ts";

export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await session.changePassword(current, next);
      setCurrent(""); setNext("");
      setMsg({ ok: true, text: "Password changed." });
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="set-changepw" onSubmit={submit}>
      <input type="password" autoComplete="current-password" placeholder="Current password"
        value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder="New password"
        value={next} onChange={(e) => setNext(e.target.value)} />
      <button className="btn-mini" type="submit" disabled={busy || !current || !next}>
        {busy ? "…" : "Change password"}
      </button>
      {msg && <span className={msg.ok ? "set-pw-ok" : "lookup-err"}>{msg.text}</span>}
    </form>
  );
}
