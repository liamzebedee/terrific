// SettingsPage — the account panel: who you are, change password, log out. A
// second example page, and where authenticated account actions live.

import React from "react";
import { session } from "../session.ts";
import { ChangePassword } from "../components/ChangePassword.tsx";

export function SettingsPage() {
  const user = session.user();
  return (
    <div className="page">
      <div className="set-account">
        <span className="set-account-who">
          {user?.username} <span className="set-account-email">{user?.email}</span>
        </span>
        <button className="btn-logout" onClick={() => session.logout()}>Log out</button>
      </div>
      <ChangePassword />
    </div>
  );
}
