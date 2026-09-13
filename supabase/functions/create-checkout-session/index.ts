// ContractIQ Platform · Supabase Edge Function · create-checkout-session
// ---------------------------------------------------------------
// Starts a Stripe Checkout session and hands the browser Stripe's hosted
// payment page URL. The Stripe secret key exists only here; the browser
// never sees it, and checkout.html needs no publishable key because it
// simply redirects.
//
// Two things can be bought:
//
//   plan     — a monthly subscription (Growth, Scale). The buyer is
//              usually NOT signed in yet, so no login is required. The
//              webhook parks the payment against their email and it is
//              claimed the moment they create their account.
//
//   credits  — a one-off credit pack, bought from inside the app when an
//              account runs low. The buyer IS signed in, and the account
//              is taken from their session token, never from the request
//              body — otherwise anyone could top up anyone else's
//              workspace, or their own, for free.
//
// PRICES COME FROM THE DATABASE (plan_catalogue and credit_packs), not
// from this file. Change a price in Supabase and the site, the app and
// Stripe all follow. That is deliberate: a price in three places is a
// price that will disagree with itself.
//
// DEPLOY
//   Supabase → Edge Functions → Deploy a new function → Via Editor
//   Name it  create-checkout-session  and paste this file in.
//   Enforce JWT verification: OFF.
//     ← buyers of a plan are not signed in yet. Credit-pack purchases
//       still require a token; that is checked in code below.
//
// SECRETS
//   STRIPE_SECRET_KEY  = sk_test_...   from the Stripe sandbox
//   ALLOWED_ORIGIN     = already set for anthropic-proxy, reused here
//   STRIPE_ALLOW_LIVE  = true          ONLY when you are ready to take
//                                      real money. Until then a live key
//                                      is refused outright.
//
// TEST CARD: 4242 4242 4242 4242, any future expiry, any CVC, any postcode.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const STRIPE_KEY     = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const ALLOW_LIVE     = Deno.env.get("STRIPE_ALLOW_LIVE") === "true";
const TEST_MODE      = /^(sk|rk)_test_/.test(STRIPE_KEY);
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_KEY || ANON_KEY, { auth: { persistSession: false } });

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin || ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

// The deployed site, plus localhost while the key is a test key, so
// checkout can be tried from your own machine without touching
// ALLOWED_ORIGIN (which anthropic-proxy also relies on).
function originAllowed(origin: string): boolean {
  if (!ALLOWED_ORIGIN) return true;
  if (origin === ALLOWED_ORIGIN) return true;
  return TEST_MODE && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// Stripe's API takes form encoding with bracketed keys for nested fields.
function form(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") out.append(k, String(v));
  }
  return out.toString();
}

// Stripe metadata values are capped at 500 characters.
const clip = (s: unknown) => String(s ?? "").trim().slice(0, 500);

serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });
  if (!originAllowed(origin))   return json(403, { error: "Origin not allowed" });

  if (!STRIPE_KEY) return json(500, { error: "Server is missing STRIPE_SECRET_KEY" });
  if (!TEST_MODE && !ALLOW_LIVE) {
    return json(500, { error: "A live Stripe key is set but STRIPE_ALLOW_LIVE is not. Refusing to take real payments." });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid request" }); }

  // Where to send the buyer afterwards. The page supplies its own folder
  // so this works on a GitHub Pages project path, a custom domain or
  // localhost alike — but it must be the same origin that called us,
  // or this becomes an open redirect.
  let base: URL;
  try { base = new URL(String(body.returnBase)); } catch { return json(400, { error: "Invalid return address" }); }
  if (origin && base.origin !== origin) return json(400, { error: "Invalid return address" });

  const buying = String(body.buying ?? "plan");

  // ═══ A credit pack ═════════════════════════════════════════════
  if (buying === "credits") {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json(401, { error: "Please sign in before buying credits." });
    }

    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const user = userData?.user;
    if (!user) return json(401, { error: "Your session has expired. Sign in again." });

    // The account comes from the caller's own membership row, read under
    // their own Row Level Security. Never from the request body.
    const { data: membership } = await asUser
      .from("account_members").select("account_id").limit(1).maybeSingle();
    const accountId = membership?.account_id;
    if (!accountId) return json(403, { error: "This sign-in is not attached to a workspace." });

    const code = clip(body.pack || "credits100");
    const { data: packs } = await db.from("credit_packs")
      .select("code, name, credits, price_pence, currency, stripe_price_id, active")
      .eq("code", code).eq("active", true).limit(1);
    const pack = packs?.[0];
    if (!pack) return json(400, { error: "That credit pack is not available." });

    const lineItem = pack.stripe_price_id
      ? { "line_items[0][price]": pack.stripe_price_id }
      : {
          "line_items[0][price_data][currency]": pack.currency ?? "gbp",
          "line_items[0][price_data][unit_amount]": pack.price_pence,
          "line_items[0][price_data][product_data][name]":
            `ContractIQ Platform — ${pack.name}`,
        };

    const upstream = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form({
        mode: "payment",
        customer_email: user.email ?? undefined,
        ...lineItem,
        "line_items[0][quantity]": 1,
        success_url: new URL(`success.html?bought=credits&credits=${pack.credits}`, base).href
                     + "&session_id={CHECKOUT_SESSION_ID}",
        cancel_url:  new URL("app/index.html?topup=cancelled", base).href,
        billing_address_collection: "required",
        "metadata[account_id]": accountId,
        "metadata[credits]":    String(pack.credits),
        "metadata[pack]":       pack.code,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("Stripe error (credits):", data?.error?.message ?? upstream.status);
      return json(502, { error: "We could not start checkout. Please try again or contact support." });
    }
    console.log(`credit checkout ${data.id} · ${pack.code} · account ${accountId} · ${TEST_MODE ? "TEST" : "LIVE"}`);
    return json(200, { url: data.url });
  }

  // ═══ A subscription ════════════════════════════════════════════
  const planKey = String(body.plan ?? "");
  const { data: plans } = await db.from("plan_catalogue")
    .select("plan, name, price_pence, currency, stripe_price_id, self_serve")
    .eq("plan", planKey).limit(1);
  const plan = plans?.[0];

  if (!plan || !plan.self_serve || !plan.price_pence) {
    return json(400, { error: "That plan is not sold through card checkout. Please contact us." });
  }

  const email = clip(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(400, { error: "Please enter a valid work email address." });
  }

  const successUrl = new URL(`success.html?plan=${planKey}`, base).href + "&session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl  = new URL(`checkout.html?plan=${planKey}&cancelled=1`, base).href;

  // Carried on both the session and the subscription, so the webhook has
  // what it needs whichever event reaches it first.
  const details: Record<string, string> = {
    plan: planKey,
    email,
    first_name:       clip(body.firstName),
    last_name:        clip(body.lastName),
    company:          clip(body.company),
    country:          clip(body.country),
    vat_number:       clip(body.vatNumber),
    marketing_opt_in: body.marketing ? "true" : "false",
    // What the buyer confirmed, kept with the subscription in Stripe so
    // there is a record outside our own database.
    accepted_terms:    body.acceptedTerms    ? "true" : "false",
    accepted_business: body.acceptedBusiness ? "true" : "false",
    accepted_ai:       body.acceptedAiNotice ? "true" : "false",
    accepted_at:       clip(body.acceptedAt),
    terms_version:     clip(body.termsVersion),
  };
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(details)) {
    metadata[`metadata[${k}]`] = v;
    metadata[`subscription_data[metadata][${k}]`] = v;
  }

  const lineItem = plan.stripe_price_id
    ? { "line_items[0][price]": plan.stripe_price_id }
    : {
        "line_items[0][price_data][currency]": plan.currency ?? "gbp",
        "line_items[0][price_data][unit_amount]": plan.price_pence,
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": `ContractIQ Platform — ${plan.name}`,
      };

  const upstream = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form({
      mode: "subscription",
      customer_email: email,
      ...lineItem,
      "line_items[0][quantity]": 1,
      success_url: successUrl,
      cancel_url: cancelUrl,
      billing_address_collection: "required",
      allow_promotion_codes: true,
      ...metadata,
    }),
  });

  const data = await upstream.json();
  if (!upstream.ok) {
    console.error("Stripe error:", data?.error?.message ?? upstream.status);
    return json(502, { error: "We could not start checkout. Please try again or contact support." });
  }

  console.log(`checkout session ${data.id} · ${planKey} · ${TEST_MODE ? "TEST" : "LIVE"}`);
  return json(200, { url: data.url });
});
