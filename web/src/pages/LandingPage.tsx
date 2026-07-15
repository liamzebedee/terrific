// The product landing page for termset — a single-screen marketing page:
// title, demo video, and a $25 buy/download button.
//
// The buy flow is STUBBED (no backend, no Stripe yet). Clicking "Buy" runs a
// fake checkout that resolves after a beat and drops the visitor on a success
// view with a (fabricated) license key + download links. Swap `fakeCheckout`
// for a real Stripe Checkout redirect and the download links for signed,
// single-use URLs minted by the backend when that lands.

import React, { useState } from "react";
import logoUrl from "../assets/termset.svg";
import demoUrl from "../assets/demo.png";

const PRICE_USD = 25;

// Platforms we ship binaries for. `href` is a placeholder until the backend
// mints signed, single-use download URLs.
const DOWNLOADS = [
  { os: "macOS", note: "Apple Silicon & Intel", file: "termset-macos.dmg", href: "#" },
  { os: "Linux", note: "x86_64 · .tar.gz / .deb", file: "termset-linux.tar.gz", href: "#" },
] as const;

type Stage = "landing" | "buying" | "success";

// Fabricate a license-key-looking string, client-side, for the stubbed flow.
function makeLicenseKey(): string {
  const block = () =>
    Array.from({ length: 4 }, () =>
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
    ).join("");
  return `TS-${block()}-${block()}-${block()}`;
}

// Stand-in for a real Stripe Checkout round-trip.
function fakeCheckout(): Promise<{ licenseKey: string }> {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ licenseKey: makeLicenseKey() }), 1400),
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="34" height="34">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

export function LandingPage() {
  const [stage, setStage] = useState<Stage>("landing");
  const [licenseKey, setLicenseKey] = useState("");
  const [playing, setPlaying] = useState(false);

  async function handleBuy() {
    setStage("buying");
    const { licenseKey } = await fakeCheckout();
    setLicenseKey(licenseKey);
    setStage("success");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (stage === "success") {
    return <SuccessView licenseKey={licenseKey} onBack={() => setStage("landing")} />;
  }

  return (
    <main className="lp">
      <header className="lp-topbar">
        <a className="lp-brand" href="/">
          <img src={logoUrl} alt="" className="lp-brand-mark" />
          <span>termset</span>
        </a>
        <button className="lp-buy lp-buy--sm" onClick={handleBuy} disabled={stage === "buying"}>
          {stage === "buying" ? "…" : `Buy · $${PRICE_USD}`}
        </button>
      </header>

      <section className="lp-hero">
        <p className="lp-eyebrow">A terminal for people drowning in tabs</p>
        <h1 className="lp-title">
          Too many Claude Code instances?
          <br />
          <span className="lp-title-accent">Organize your terminal.</span>
        </h1>
        <p className="lp-sub">
          termset keeps every session labelled and grouped, so your terminal never
          becomes a mess of unlabeled tabs. Swap between them from the keyboard —
          stop hunting for which tab you’re on and get back to work.
        </p>

        <div className="lp-cta">
          <button className="lp-buy" onClick={handleBuy} disabled={stage === "buying"}>
            {stage === "buying" ? "Starting checkout…" : `Buy & download · $${PRICE_USD}`}
          </button>
          <div className="lp-platforms">
            <span className="lp-plat">macOS</span>
            <span className="lp-dot" />
            <span className="lp-plat">Linux</span>
          </div>
        </div>
      </section>

      <section className="lp-videowrap">
        <div className={`lp-video ${playing ? "is-playing" : ""}`}>
          <img src={demoUrl} alt="termset running a full-stack workspace" className="lp-video-poster" />
          {!playing && (
            <button className="lp-play" onClick={() => setPlaying(true)} aria-label="Play demo">
              <PlayGlyph />
            </button>
          )}
          {playing && <div className="lp-video-badge">Demo reel coming soon</div>}
        </div>
      </section>

      <section className="lp-features">
        <Feature title="Everything labelled">
          Name and group your tabs. A workspace of ten terminals reads at a glance
          instead of “zsh, zsh, zsh, zsh.”
        </Feature>
        <Feature title="Keyboard-first switching">
          Jump to any session with a keystroke. No more clicking around to find the
          tab you left running.
        </Feature>
        <Feature title="Layouts you can commit">
          Save your terminal layout to a YAML file — commit it to git and open the
          same workspace on every device.
        </Feature>
      </section>

      <footer className="lp-footer">
        <span>© termset</span>
        <span className="lp-footer-note">macOS & Linux · one-time ${PRICE_USD} · free updates</span>
      </footer>
    </main>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lp-feature">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function SuccessView({ licenseKey, onBack }: { licenseKey: string; onBack: () => void }) {
  return (
    <main className="lp lp--success">
      <section className="lp-success-card">
        <div className="lp-check" aria-hidden="true">✓</div>
        <h1>You’re in. Thanks for buying termset.</h1>
        <p className="lp-sub">
          Your download links are below. We’ve also emailed them along with your
          license key — keep the key to activate updates.
        </p>

        <div className="lp-license">
          <span className="lp-license-label">License key</span>
          <code>{licenseKey}</code>
        </div>

        <div className="lp-downloads">
          {DOWNLOADS.map((d) => (
            <a key={d.os} className="lp-download" href={d.href}>
              <span className="lp-download-os">{d.os}</span>
              <span className="lp-download-note">{d.note}</span>
              <span className="lp-download-file">{d.file}</span>
            </a>
          ))}
        </div>

        <p className="lp-fineprint">
          Links are placeholders in this prototype — the real build hands out
          signed, single-use URLs so they can’t be shared.
        </p>
        <button className="lp-textbtn" onClick={onBack}>← Back to home</button>
      </section>
    </main>
  );
}
