// Billing HTTP routes — the buy-a-license flow.
//
//   POST /api/checkout          -> { url }   start a Stripe Checkout Session
//   POST /api/stripe/webhook    -> 200        Stripe calls this on payment
//   GET  /api/license?session_id -> { licenseKey } | 202 (pending)
//
// These are plain HTTP routes, not Connect RPC: Stripe posts a raw signed body
// to the webhook, and the checkout redirect / success poll are simple GET/POST.
// Registered in src/api/router.ts alongside the RPC routes.
//
// Flow: the landing page POSTs /api/checkout and redirects to Stripe. On
// payment, Stripe calls the webhook; we mint an Ed25519-signed license for the
// buyer's email, store it against the session, and email it. The success page
// (redirected back with ?session_id=…) polls /api/license to display the key.

import { issueForSession, licenseForSession } from "../license.ts";
import { createCheckoutSession, retrieveSession, verifyWebhook } from "../stripe.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Swap this for a real provider (Cloudflare Email, Resend, SES…). Best-effort:
// a delivery failure must never fail the webhook, or Stripe will keep retrying
// a payment that already succeeded.
async function emailLicense(to: string, licenseKey: string): Promise<void> {
  console.log(`[license] issue -> ${to}\n  key: ${licenseKey}`);
}

async function handleCheckout(): Promise<Response> {
  try {
    const { url } = await createCheckoutSession();
    return json({ url });
  } catch (err) {
    console.error("[checkout]", err);
    return json({ error: "Could not start checkout." }, 500);
  }
}

async function handleWebhook(req: Request): Promise<Response> {
  const payload = await req.text();
  if (!verifyWebhook(payload, req.headers.get("stripe-signature"))) {
    return new Response("invalid signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email: string = session.customer_details?.email ?? session.customer_email ?? "";
    const name: string = session.customer_details?.name ?? "";
    if (email) {
      const { licenseKey } = issueForSession({
        sessionId: session.id,
        email,
        name,
        createdUnix: session.created ?? Math.floor(Date.now() / 1000),
      });
      await emailLicense(email, licenseKey);
    } else {
      console.error("[webhook] completed session had no email:", session.id);
    }
  }
  return new Response("ok", { status: 200 });
}

async function handleLicense(req: Request): Promise<Response> {
  const sessionId = new URL(req.url).searchParams.get("session_id");
  if (!sessionId) return json({ error: "session_id required" }, 400);

  // Already minted (webhook has run): return it.
  const stored = licenseForSession(sessionId);
  if (stored) return json({ licenseKey: stored.licenseKey, email: stored.email });

  // Not yet. The webhook is the source of truth, but it can lag the redirect by
  // a moment, so fall back to reading the session directly — if it's paid, mint
  // now (idempotent) rather than making the buyer wait on webhook delivery.
  try {
    const session = await retrieveSession(sessionId);
    if (session.payment_status === "paid") {
      const email = session.customer_details?.email ?? session.customer_email ?? "";
      if (email) {
        const { licenseKey } = issueForSession({
          sessionId: session.id,
          email,
          name: session.customer_details?.name ?? "",
          createdUnix: session.created ?? Math.floor(Date.now() / 1000),
        });
        return json({ licenseKey, email });
      }
    }
  } catch (err) {
    console.error("[license]", err);
  }
  return json({ pending: true }, 202);
}

export const billingRoutes = {
  "/api/checkout": { POST: handleCheckout },
  "/api/stripe/webhook": { POST: handleWebhook },
  "/api/license": { GET: handleLicense },
};
