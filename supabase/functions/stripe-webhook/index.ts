// ContractIQ Platform · Supabase Edge Function · stripe-webhook
// ---------------------------------------------------------------
// This is the piece that was missing. Without it a customer could pay
// Stripe successfully and nothing whatsoever changed in the product:
// they stayed on the sandbox plan with 150 credits, having just been
// charged £79.
//
// Stripe tells us what happened; this function writes it down.
//
// DEPLOY
//   Supabase → Edge Functions → Deploy a new function → Via Editor
//   Name it  stripe-webhook  and paste this file in.
//   Enforce JWT verification: OFF.
//     ← Stripe is a server calling us. It has no Supabase login and
//       never will. The request is authenticated by its SIGNATURE
//       instead, checked below. This is the one function where "off"
//       is correct, and the signature check is what makes it safe.
//
// SECRETS
//   STRIPE_SECRET_KEY    = sk_test_...   (same key as create-checkout-session)
//   STRIPE_WEBHOOK_SECRET= whsec_...     (Stripe → Developers → Webhooks →
//                                         your endpoint → Signing secret)
//
// POINT STRIPE AT IT
//   Stripe → Developers → Webhooks → Add endpoint
//   URL:  https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook
//   Events: checkout.session.completed, invoice.payment_succeeded,
//           invoice.payment_failed, customer.subscription.deleted,
//           customer.subscription.updated
//
// TEST IT: Stripe → Developers → Webhooks → your endpoint → "Send test
// webhook". You should see a 200 here and a row in stripe_events.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const STRIPE_KEY     = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── Signature verification ─────────────────────────────────────
// Done by hand rather than with the Stripe SDK: it is about twenty
// lines, it has no version to keep up to date, and it means this file
// works on its own. Without this check anyone could POST a fake
// "payment succeeded" and help themselves to an Enterprise plan.

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSignature(
  rawBody: string, header: string, secret: string, toleranceSeconds = 300,
): Promise<{ ok: boolean; reason?: string }> {
  if (!header) return { ok: false, reason: "no signature header" };

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") timestamp = v?.trim() ?? "";
    if (k?.trim() === "v1") signatures.push(v?.trim() ?? "");
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: "malformed signature header" };

  // A replayed request from an hour ago is not a request.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  return signatures.some((s) => timingSafeEqual(s, expected))
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

// Stripe puts only ids in most payloads. Fetch the full object when the
// detail matters.
async function stripeGet(path: string): Promise<Record<string, unknown> | null> {
  if (!STRIPE_KEY) return null;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!r.ok) { console.error(`stripe GET ${path} → ${r.status}`); return null; }
  return await r.json();
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // The body must be read as raw text. Parsing it to JSON and
  // re-stringifying changes the bytes and the signature will never match.
  const rawBody = await req.text();

  if (!WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET is not set — refusing to trust this request");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const check = await verifyStripeSignature(rawBody, req.headers.get("stripe-signature") ?? "", WEBHOOK_SECRET);
  if (!check.ok) {
    console.error("signature rejected:", check.reason);
    return new Response(`Signature verification failed: ${check.reason}`, { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }

  // Stripe delivers the same event more than once by design. Record it
  // first; if we have seen it before, acknowledge and stop.
  const { data: seen, error: seenErr } = await db.rpc("stripe_event_seen", {
    p_id: event.id, p_type: event.type, p_payload: null,
  });
  if (seenErr) {
    // Returning 500 makes Stripe retry, which is what we want: better a
    // retry than a payment silently dropped.
    console.error("stripe_event_seen failed", seenErr.message);
    return new Response("Could not record event", { status: 500 });
  }
  if (seen === true) {
    console.log(`duplicate ${event.type} ${event.id} — already handled`);
    return new Response("ok (duplicate)", { status: 200 });
  }

  try {
    switch (event.type) {
      // ── Someone paid ────────────────────────────────────────
      case "checkout.session.completed": {
        const s = event.data.object;
        const md = s.metadata ?? {};
        const email = (s.customer_details?.email ?? s.customer_email ?? md.email ?? "").toLowerCase();

        if (s.mode === "payment") {
          // A credit pack. The buyer is signed in, so the account came
          // through on the metadata and we can apply it directly.
          const credits = Number(md.credits ?? 0);
          const accountId = md.account_id || null;
          if (!accountId || !credits) {
            console.error("credit pack with no account_id or credits", s.id);
            break;
          }
          const { error } = await db.rpc("billing_apply_credits", {
            p_account_id: accountId, p_credits: credits, p_reference: s.id,
          });
          if (error) throw new Error(error.message);
          console.log(`+${credits} credits → account ${accountId} (${s.id})`);
          break;
        }

        // A subscription. The buyer may not have signed up yet — that is
        // normal for self-serve — so this may park against their email
        // and be claimed the moment they create their login.
        const { data, error } = await db.rpc("billing_checkout_completed", {
          p_email:        email,
          p_plan:         String(md.plan ?? "growth"),
          p_customer:     s.customer ?? null,
          p_subscription: s.subscription ?? null,
          p_account_id:   md.account_id || null,
          p_first_name:   md.first_name ?? null,
          p_last_name:    md.last_name ?? null,
          p_company:      md.company ?? null,
          p_country:      md.country ?? null,
          p_vat:          md.vat_number ?? null,
          p_marketing:    md.marketing_opt_in === "true",
        });
        if (error) throw new Error(error.message);
        console.log(`checkout ${s.id} · ${md.plan} · ${email} · ${data?.applied ? "applied" : "parked until sign-up"}`);
        break;
      }

      // ── The monthly renewal went through: roll the allowance ──
      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        const subId = inv.subscription;
        if (!subId) break;

        // The very first invoice arrives alongside checkout.session.completed,
        // which has already set the plan and started the period. Rolling it
        // again here would reset a period that is seconds old.
        if (inv.billing_reason === "subscription_create") {
          console.log(`first invoice for ${subId} — plan already applied at checkout`);
          break;
        }

        const { data: accts } = await db.from("accounts")
          .select("id, plan").eq("stripe_subscription_id", subId).limit(1);
        const acct = accts?.[0];
        if (!acct) { console.error(`no account for subscription ${subId}`); break; }

        const { error } = await db.rpc("billing_apply_plan", {
          p_account_id: acct.id, p_plan: acct.plan,
          p_customer: inv.customer ?? null, p_subscription: subId,
          p_reset_period: true,
        });
        if (error) throw new Error(error.message);
        console.log(`renewed ${acct.id} on ${acct.plan}`);
        break;
      }

      // ── The card failed ─────────────────────────────────────
      case "invoice.payment_failed": {
        const inv = event.data.object;
        if (!inv.subscription) break;
        // Flagged, not cut off. Stripe retries for days, and cutting
        // access on the first failure loses customers over expired cards.
        const { error } = await db.rpc("billing_payment_failed", {
          p_subscription: inv.subscription, p_invoice: inv.id,
        });
        if (error) throw new Error(error.message);
        console.log(`payment failed on ${inv.subscription} — marked past_due`);
        break;
      }

      // ── Cancelled, or ended ─────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const { error } = await db.rpc("billing_subscription_ended", {
          p_subscription: sub.id, p_status: "cancelled",
        });
        if (error) throw new Error(error.message);
        console.log(`subscription ${sub.id} ended`);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
          const { error } = await db.rpc("billing_subscription_ended", {
            p_subscription: sub.id, p_status: sub.status,
          });
          if (error) throw new Error(error.message);
          console.log(`subscription ${sub.id} → ${sub.status}`);
          break;
        }

        // A plan change. Read the price back off the subscription and
        // match it to the catalogue, so an upgrade in Stripe becomes an
        // upgrade in the product.
        const priceId = sub.items?.data?.[0]?.price?.id;
        if (!priceId) break;
        const { data: rows } = await db.from("plan_catalogue")
          .select("plan").eq("stripe_price_id", priceId).limit(1);
        const plan = rows?.[0]?.plan;
        if (!plan) { console.log(`price ${priceId} is not in plan_catalogue — ignoring`); break; }

        const { data: accts } = await db.from("accounts")
          .select("id").eq("stripe_subscription_id", sub.id).limit(1);
        if (!accts?.[0]) break;

        const { error } = await db.rpc("billing_apply_plan", {
          p_account_id: accts[0].id, p_plan: plan,
          p_customer: sub.customer ?? null, p_subscription: sub.id,
          p_reset_period: false,
        });
        if (error) throw new Error(error.message);
        console.log(`subscription ${sub.id} → plan ${plan}`);
        break;
      }

      default:
        console.log(`ignoring ${event.type}`);
    }
  } catch (e) {
    // 500 asks Stripe to retry. The event id is already recorded, so the
    // retry would be treated as a duplicate and skipped — so remove it,
    // and let the retry do the work properly.
    console.error(`handler failed for ${event.type} ${event.id}`, e);
    await db.from("stripe_events").delete().eq("id", event.id);
    return new Response("Handler failed — please retry", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
