// Where the auth token + cached user live in the browser.
//
// "Remember me" is just which Web Storage backs the session:
//   • remember  → localStorage   (survives browser restarts — the default)
//   • otherwise → sessionStorage (cleared when the tab/window closes)
// Reads check sessionStorage first so a deliberately non-remembered login
// shadows any stale localStorage token from a previous remembered one.
//
// Dependency-free on purpose: both the RPC transport (rpc.ts, which attaches the
// token) and the session helper (session.ts) import it, so it must not import
// either — that would be a cycle.

const TOKEN_KEY = "auth.token";
const USER_KEY = "auth.user";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
}

export function getUserRaw(): string | null {
  return sessionStorage.getItem(USER_KEY) ?? localStorage.getItem(USER_KEY);
}

// Persist a fresh login into the chosen store, clearing the other so exactly one
// store ever holds a session.
export function setAuth(token: string, userJson: string, remember: boolean): void {
  const [store, other] = remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
  store.setItem(TOKEN_KEY, token);
  store.setItem(USER_KEY, userJson);
  other.removeItem(TOKEN_KEY);
  other.removeItem(USER_KEY);
}

// Update the cached user in whichever store currently holds the session.
export function setUserRaw(userJson: string): void {
  const store = sessionStorage.getItem(TOKEN_KEY) != null ? sessionStorage : localStorage;
  store.setItem(USER_KEY, userJson);
}

export function clearAuth(): void {
  for (const store of [localStorage, sessionStorage]) {
    store.removeItem(TOKEN_KEY);
    store.removeItem(USER_KEY);
  }
}
