// A tiny Stripe client over `fetch` — just the two calls the license flow
// needs (create a Checkout Session, retrieve one) plus manual webhook-signature
// verification. Deliberately no `stripe` npm dependency: the REST surface we
// use is small and this keeps the server dependency-free and easy to audit.
//
// Configure via env (see .env.example):
//   STRIPE_SECRET_KEY       sk_test_… / sk_live_…
//   STRIPE_PRICE_ID         price_…  (a one-time $25 price on your product)
//   STRIPE_WEBHOOK_SECRET   whsec_…  (from the webhook endpoint config)
//   PUBLIC_BASE_URL         where the site is served (for success/cancel URLs)

import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.stripe.com/v1";

function secretKey(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error("STRIPE_SECRET_KEY is not set");
  return k;
}

export function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

// Stripe wants application/x-www-form-urlencoded with bracketed nested keys.
function formEncode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function stripePost(path: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${path} failed: ${json?.error?.message ?? res.status}`);
  }
  return json;
}

// Create a one-time-payment Checkout Session for the license price. Returns the
// hosted-checkout URL to redirect the buyer to.
export async function createCheckoutSession(): Promise<{ id: string; url: string }> {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error("STRIPE_PRICE_ID is not set");
  const session = await stripePost("/checkout/sessions", {
    mode: "payment",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    // Collect the email so we can put it in the license + email the key.
    success_url: `${baseUrl()}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl()}/`,
    "automatic_tax[enabled]": "false",
  });
  return { id: session.id, url: session.url };
}

export async function retrieveSession(id: string): Promise<any> {
  const res = await fetch(`${API}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe retrieve failed: ${json?.error?.message ?? res.status}`);
  return json;
}

// Verify a webhook payload against the `Stripe-Signature` header, implementing
// Stripe's scheme: sign `${t}.${payload}` with HMAC-SHA256(webhook_secret) and
// compare to the `v1=` signature, rejecting timestamps older than `toleranceS`.
export function verifyWebhook(payload: string, sigHeader: string | null, toleranceS = 300): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > toleranceS) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
