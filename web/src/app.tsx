// The app shell — the client entry point.
//
// For now this renders only the public product landing page (LandingPage). The
// authenticated app (topbar + Items/Settings tabs, gated on session.isLoggedIn)
// is intentionally hidden until users/backend are wired up — the previous shell
// lives in git history and the page components remain under src/pages/.

import "./utils/swallow-extension-errors.ts"; // must be first: silence injected-extension errors before the dev overlay sees them
import React from "react";
import { createRoot } from "react-dom/client";
import { LandingPage } from "./pages/LandingPage.tsx";

function App() {
  return <LandingPage />;
}

createRoot(document.getElementById("root")!).render(<App />);
