// The product landing page for termset — a single-screen marketing page:
// title, demo video, and a $25 buy/download button.
//
// The buy flow is REAL Stripe Checkout: clicking "Buy" POSTs /api/checkout and
// redirects to Stripe's hosted checkout. On payment Stripe returns the visitor
// to `/?session_id=…`; the page then polls /api/license (backed by the webhook
// that minted an Ed25519-signed key) and shows the key + download links. See
// web/src/api/billing.ts. In test mode without keys, /api/checkout 500s and the
// CTA shows a "not configured" hint.

import React, { useEffect, useState } from "react";
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
  const [notice, setNotice] = useState("");

  // Returning from Stripe Checkout: poll the backend for the minted key.
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (!sessionId) return;
    setStage("buying");
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      try {
        const res = await fetch(`/api/license?session_id=${encodeURIComponent(sessionId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.licenseKey && !cancelled) {
            setLicenseKey(data.licenseKey);
            setStage("success");
            window.history.replaceState(null, "", "/");
            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }
        }
      } catch {
        /* transient — keep polling */
      }
      if (cancelled) return;
      if (tries++ < 12) {
        setTimeout(poll, 1500);
      } else {
        setNotice("Payment received. Your license key is on its way by email.");
        setStage("landing");
        window.history.replaceState(null, "", "/");
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleBuy() {
    setStage("buying");
    setNotice("");
    try {
      const res = await fetch("/api/checkout", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setNotice("Checkout is not configured yet — add your Stripe keys to enable it.");
    } catch {
      setNotice("Could not reach checkout. Try again in a moment.");
    }
    setStage("landing");
  }

  function handleDownload() {
    setNotice("Trial builds land soon. Buy now and you’ll get the download the day it ships.");
  }

  if (stage === "success") {
    return <SuccessView licenseKey={licenseKey} onBack={() => setStage("landing")} />;
  }

  const buyLabel = stage === "buying" ? "starting checkout…" : `buy · $${PRICE_USD}`;

  return (
    <main className="lp lp--plain">
      <nav className="nav">
        <a className="nav-brand" href="#top">
          <img src={logoUrl} alt="" className="nav-mark" />
          <span>termset</span>
        </a>
        <button className="btn btn-primary btn-sm" onClick={handleBuy} disabled={stage === "buying"}>
          {buyLabel}
        </button>
      </nav>

      <section className="pitch" id="top">
        <div className="pitch-main">
          <div className="pitch-text">
            <p>how many terminal tabs do you have open?</p>
            <p>is it clean, or is it a mess?</p>
            <p>I struggled with this too. So I built my own.</p>
          </div>

          <ul className="pitch-list">
            <li>see everything at once (vertical tabs)</li>
            <li>automatic tab naming</li>
            <li>swap tabs as fast as possible - keyboard</li>
            <li>macOS and Linux cross-platform</li>
            <li>full power - maximal screen space UI</li>
            <li>Rust-based, GPU-accelerated</li>
          </ul>

          <div className="cta">
            <button className="btn btn-primary" onClick={handleBuy} disabled={stage === "buying"}>
              {stage === "buying" ? "starting checkout…" : `buy a license — $${PRICE_USD}`}
            </button>
            <button className="btn btn-ghost" onClick={handleDownload}>download free trial</button>
          </div>
          <p className="cta-note">free to try. one payment, no subscription.</p>
          {notice && <p className="notice">{notice}</p>}
        </div>

        <div className={`shot ${playing ? "is-playing" : ""}`}>
          <img src={demoUrl} alt="termset running a full-stack workspace" className="shot-img" />
          {!playing ? (
            <button className="shot-play" onClick={() => setPlaying(true)} aria-label="Play demo">
              <PlayGlyph />
            </button>
          ) : (
            <div className="shot-badge">demo reel coming soon</div>
          )}
        </div>
      </section>

      <footer className="foot">
        <span>© termset</span>
        <span className="foot-note">macOS and Linux · pay once · free updates</span>
      </footer>
    </main>
  );
}

function SuccessView({ licenseKey, onBack }: { licenseKey: string; onBack: () => void }) {
  return (
    <main className="lp lp--success">
      <section className="lp-success-card">
        <div className="lp-check" aria-hidden="true">✓</div>
        <h1>That’s it. termset is yours.</h1>
        <p className="lp-sub">
          Your license key is below, and it’s in your inbox too. Paste it into
          termset to register, and keep it for when you reinstall.
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
          These download links are placeholders for now. The real build hands out
          signed, single-use URLs.
        </p>
        <button className="lp-textbtn" onClick={onBack}>← Back to home</button>
      </section>
    </main>
  );
}
