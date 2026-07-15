// Frontend session — a thin auth helper over localStorage. The backend mints a
// JWT on login/register; we cache it (and the user) and expose `isLoggedIn()`
// and `user()` so the app shell can gate itself. The RPC transport (rpc.ts)
// reads the token straight from storage to authorize every request.

import { rpc } from "./rpc.ts";
import { clearAuth, getToken, getUserRaw, setAuth } from "./auth-store.ts";
import type { UserView } from "./proto/index.ts";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
}

const AUTH_EVENT = "auth-changed";

const toUser = (v: UserView): AuthUser => ({ id: v.id, email: v.email, username: v.username });

// Persist a fresh login into the chosen store (remember → localStorage).
function storeSession(token: string, user: AuthUser, remember: boolean): void {
  setAuth(token, JSON.stringify(user), remember);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export const session = {
  isLoggedIn: (): boolean => !!getToken(),

  user(): AuthUser | null {
    const s = getUserRaw();
    try {
      return s ? (JSON.parse(s) as AuthUser) : null;
    } catch {
      return null;
    }
  },

  // Subscribe to login/logout changes. Returns an unsubscribe fn.
  onChange(fn: () => void): () => void {
    window.addEventListener(AUTH_EVENT, fn);
    return () => window.removeEventListener(AUTH_EVENT, fn);
  },

  // `remember` (default true — the app keeps you signed in) persists to
  // localStorage; false uses sessionStorage, ending the session at browser close.
  async login(email: string, password: string, remember = true): Promise<void> {
    const { token, user } = await rpc.auth.login({ email, password });
    storeSession(token, toUser(user!), remember);
  },

  async register(email: string, username: string, password: string, remember = true): Promise<void> {
    const { token, user } = await rpc.auth.register({ email, username, password });
    storeSession(token, toUser(user!), remember);
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await rpc.auth.changePassword({ currentPassword, newPassword });
  },

  logout(): void {
    clearAuth();
    window.dispatchEvent(new Event(AUTH_EVENT));
  },
};
