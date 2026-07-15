// Login / register, shown by the app shell whenever the user is logged out.
// On success `session` stores the token and fires "auth-changed", which flips
// the shell to the app — no callback needed here.

import React, { useEffect, useState } from "react";
import { session } from "../session.ts";
import { errMsg } from "../rpc.ts";

type Mode = "login" | "register";

// The page to return to after auth. Same-origin paths only (must start with a
// single "/") so a crafted ?redirect= can't bounce us off-site.
function redirectTarget(): string {
  const raw = new URLSearchParams(location.search).get("redirect");
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/items";
}

export function AuthPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const register = mode === "register";

  // Preserve the page the user was headed for in the URL, then sit on /login.
  // Runs once on mount (i.e. whenever the app gates to the login screen).
  useEffect(() => {
    if (location.pathname !== "/login") {
      const from = location.pathname + location.search;
      history.replaceState({}, "", `/login?redirect=${encodeURIComponent(from)}`);
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (register) await session.register(email, username, password, remember);
      else await session.login(email, password, remember);
      // Success: return to where they were headed (session fired auth-changed,
      // so the shell is about to swap in the app — set the path it will read).
      history.replaceState({}, "", redirectTarget());
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card auth-form" onSubmit={submit}>
        <h1 className="auth-title">{register ? "Create account" : "Sign in"}</h1>
        <p className="auth-sub">App Template</p>

        {error && <div className="auth-error">{error}</div>}

        <div className="auth-field">
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" name="email" type="email" autoComplete="email" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>

        {register && (
          <div className="auth-field">
            <label htmlFor="auth-username">Username</label>
            <input id="auth-username" name="username" type="text" autoComplete="username" required
              value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
        )}

        <div className="auth-field">
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" required
            autoComplete={register ? "new-password" : "current-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        <label className="auth-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Keep me signed in
        </label>

        <button className="auth-submit" type="submit" disabled={busy}>
          {busy ? "…" : register ? "Create account" : "Sign in"}
        </button>

        <div className="auth-switch">
          {register ? "Already have an account? " : "No account yet? "}
          <button type="button" onClick={() => { setError(null); setMode(register ? "login" : "register"); }}>
            {register ? "Sign in" : "Create one"}
          </button>
        </div>
      </form>
    </div>
  );
}
