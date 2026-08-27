# Selling termset

termset is sold like Sublime Text: a one-time **$25** license, a copy that is
**fully functional forever**, and an occasional "unregistered copy" reminder
that a valid license key silences permanently. There is no server check, no
subscription, and no feature lock — the license is a convenience and a nudge,
not a DRM cage.

This document describes how the pieces fit together and how money turns into a
license key.

## The license key

A license key is a self-contained, offline-verifiable token:

```
<base64url(payload)>.<base64url(signature)>
```

- **payload** — small JSON: `{"name","email","issued":"YYYY-MM-DD","product":"termset"}`
- **signature** — an Ed25519 signature over the ASCII bytes of the base64
  payload, made with the vendor's private key.

The termset binary embeds only the **public** key (`scripts/license-pubkey.bin`,
compiled in via `include_bytes!`). Verification is therefore entirely offline:
no network, no phone-home, works on a plane. A key that verifies is genuine; a
tampered payload changes the signed bytes and fails. See `src/license.rs`
(verify) and `web/src/license.ts` (mint) — the two sides are byte-compatible
(there is a round-trip test in `src/license.rs`).

The private key is the only secret in the scheme. It lives solely in the
backend's environment (`LICENSE_PRIVKEY_B64`) and is generated with
`web/scripts/gen-license-keypair.ts`, which also writes the matching public key
into the binary's source tree.

## The purchase flow (Stripe)

```
  Landing page                Backend (web/)                 Stripe
  ────────────                ──────────────                 ──────
  Buy · $25  ──POST /api/checkout──▶ createCheckoutSession ──▶ Checkout Session
      ◀───────────────── { url } ◀──────────────────────────────────┘
      │
      └─ redirect to Stripe hosted checkout ─────────────────▶ (buyer pays)
                                                                    │
             Stripe ──POST /api/stripe/webhook (signed)────────────┘
                          │  verify signature
                          │  checkout.session.completed
                          │  mint Ed25519 license for the buyer's email
                          │  store it (session_id → key), email it
                          ▼
  Success page  ──GET /api/license?session_id=…──▶ { licenseKey }
      └─ show key + download links; key also emailed
```

Implementation:

- **`web/src/stripe.ts`** — a dependency-free Stripe client over `fetch`
  (create/retrieve Checkout Session) plus manual webhook HMAC-SHA256 signature
  verification. Small enough to audit; no `stripe` npm package required.
- **`web/src/license.ts`** — mints and persists keys. Ed25519 signing is
  deterministic, so a retried webhook re-issues the *same* key (idempotent).
  Keys are stored one row per Checkout session (`licenses` table) for the
  success-page lookup and for support re-issues.
- **`web/src/api/billing.ts`** — the three HTTP routes (`/api/checkout`,
  `/api/stripe/webhook`, `/api/license`), registered in `web/src/api/router.ts`.
- **`web/src/pages/LandingPage.tsx`** — the buy button and the post-payment poll.

### Configuration

Set these in the backend environment (`web/.env.local` for dev, secrets in prod
— see `web/.env.example`):

| Var | What |
| --- | --- |
| `LICENSE_PRIVKEY_B64` | Ed25519 private key (base64 PKCS8) that signs keys |
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` |
| `STRIPE_PRICE_ID` | a one-time $25 price on your termset product |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint |
| `PUBLIC_BASE_URL` | origin for Checkout success/cancel URLs |

`web/.env.local` ships a **dev** keypair (the pair of the committed
`scripts/license-pubkey.bin`) so the whole buy→sign→verify path runs locally the
moment you add Stripe test keys. That dev private key is committed and therefore
**not secret** — generate a fresh one for production and never commit it.

### Testing locally

1. `bun run scripts/gen-license-keypair.ts` (optional — a dev pair is already
   committed) and rebuild the app so it embeds the matching public key.
2. Create a test-mode product + one-time $25 price in the Stripe dashboard; put
   the `price_…` in `STRIPE_PRICE_ID` and your `sk_test_…` in `STRIPE_SECRET_KEY`.
3. Forward webhooks: `stripe listen --forward-to localhost:3001/api/stripe/webhook`
   and copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
4. `bun run dev`, click Buy, pay with test card `4242 4242 4242 4242`, and watch
   the key appear on the success page (and in the server log).

## The "bothering" model in the app

- **Fully functional, always.** No feature is ever disabled.
- **Launch nag.** An unregistered copy shows a reminder dialog on the first
  launch and then every 5th launch (`license::NAG_EVERY`). It has three buttons:
  *Buy License* (opens the site), *Enter Key* (the key dialog), *Continue*.
- **Menu.** The terminal right-click menu carries *Buy License…* and *Enter
  Key…* while unregistered; both disappear once a valid key is entered.
- **Storage.** The verified key is saved to `~/.config/termset/license.key`; the
  launch counter lives in `~/.config/termset/launches`.
- **Feature gate.** The entire model is behind the `licensing` cargo feature
  (on by default). `cargo build --no-default-features` compiles it out — no
  nag, no menu items, no verification — shipping an unrestricted binary. This is
  the "turn the whole model on/off" switch.

## Piracy tradeoffs (deliberate)

Offline signed keys are **shareable** — one buyer could post their key and
anyone could paste it. This is the same tradeoff Sublime Text accepts, and it is
intentional:

- It keeps honest users unbothered (offline, private, no account, no re-check).
- The key embeds the buyer's name/email, which is a mild social deterrent to
  sharing, and lets you revoke-by-shame or refuse support on leaked keys.
- If piracy ever needs tightening, options that *don't* break the offline-first
  promise: per-key issue caps surfaced through a lightweight (optional) online
  check, watermarking downloads, or signing the buyer's machine fingerprint into
  the key. None are worth building until the numbers say so.

The goal is revenue from the honest majority, not an unbreakable lock.
