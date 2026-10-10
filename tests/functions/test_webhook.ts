// Runs stripe-webhook for real against a fake Supabase, with properly
// signed Stripe events.
//
// The reason this file exists: Stripe's Basil API version (2025-03-31)
// removed `invoice.subscription`. A webhook endpoint on that version or
// later sends the id under `invoice.parent` instead, and the old code read
// only the top-level field — so renewals and failed payments were accepted
// with a 200 and did nothing at all. Both shapes are tested here.
//
//   deno run -A --config deno.json test_webhook.ts
import { calls, onRequest, J, check, summary, sleep } from "./harness.ts";

const SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "whsec_testtesttesttest";
const PORT = Number(Deno.env.get("PORT") ?? 8803);

const state = { seen: new Set<string>(), seenFails: false, accountFor: "acct-1" as string | null, rpcFails: "" };

const rowOrRows = (h: Headers, row: unknown) => (h.get("accept") ?? "").includes("pgrst.object") ? row : [row];

onRequest((u, body, h) => {
  if (u.hostname !== "sb.test") return null;
  if (u.pathname === "/rest/v1/rpc/stripe_event_seen") {
    if (state.seenFails) return J(400, { message: "no such function" });
    const id = String(body?.p_id ?? "");
    const already = state.seen.has(id);
    state.seen.add(id);
    return J(200, already);
  }
  if (u.pathname === "/rest/v1/accounts") {
    if (!state.accountFor) return J(200, rowOrRows(h, null));
    return J(200, [{ id: state.accountFor, plan: "growth" }]);
  }
  if (u.pathname === "/rest/v1/plan_catalogue") return J(200, [{ plan: "scale" }]);
  if (u.pathname.startsWith("/rest/v1/rpc/")) {
    const name = u.pathname.split("/").pop()!;
    if (state.rpcFails === name) return J(400, { message: "deliberate failure" });
    return J(200, null);
  }
  if (u.pathname.startsWith("/rest/v1/")) return J(200, null);
  return null;
});

await import("../../supabase/functions/stripe-webhook/index.ts");
await sleep(200);

// ── Signing, exactly as Stripe does it ──────────────────────────────
const enc = new TextEncoder();
async function sign(payload: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

let n = 0;
async function send(event: Record<string, unknown>, opts: { badSig?: boolean; id?: string } = {}) {
  const payload = JSON.stringify({ id: opts.id ?? `evt_${++n}`, ...event });
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers["stripe-signature"] = opts.badSig ? "t=1,v1=deadbeef" : await sign(payload);
  const r = await fetch(`http://localhost:${PORT}/`, { method: "POST", headers, body: payload });
  const text = await r.text();
  return { status: r.status, text };
}

const rpc = (name: string) => calls.filter((c) => c.url.endsWith("/rpc/" + name));
const lastRpc = (name: string) => rpc(name).at(-1)?.body;
const accountQueries = () => calls.filter((c) => c.url.includes("/rest/v1/accounts") && c.method === "GET");

console.log("stripe-webhook");

// ── 1 · The door is locked ──────────────────────────────────────────
let r = await send({ type: "checkout.session.completed", data: { object: {} } }, { badSig: true });
check("a bad signature is refused with 400", r.status === 400 && /Signature/.test(r.text), `${r.status} ${r.text}`);

// ── 2 · A subscription is bought ────────────────────────────────────
calls.length = 0;
r = await send({
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_1",
    customer_details: { email: "Buyer@Example.COM" }, metadata: { plan: "growth", email: "buyer@example.com", company: "Acme" } } },
});
check("a subscription checkout returns 200", r.status === 200 && r.text === "ok", `${r.status} ${r.text}`);
check("the sale is recorded against the buyer's email, lower-cased",
  lastRpc("billing_checkout_completed")?.p_email === "buyer@example.com"
  && lastRpc("billing_checkout_completed")?.p_plan === "growth"
  && lastRpc("billing_checkout_completed")?.p_subscription === "sub_1", JSON.stringify(lastRpc("billing_checkout_completed")));

// ── 3 · A credit pack ───────────────────────────────────────────────
calls.length = 0;
r = await send({
  type: "checkout.session.completed",
  data: { object: { id: "cs_2", mode: "payment", customer_details: { email: "a@b.test" },
    metadata: { account_id: "acct-9", credits: "100", pack: "credits100" } } },
});
check("a credit pack adds the credits to the buyer's own workspace",
  r.status === 200 && lastRpc("billing_apply_credits")?.p_account_id === "acct-9"
  && lastRpc("billing_apply_credits")?.p_credits === 100, JSON.stringify(lastRpc("billing_apply_credits")));

// ── 4 · The renewal, in both API shapes ─────────────────────────────
// This is the one that silently did nothing. Pre-Basil shape first.
calls.length = 0;
r = await send({
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_1", billing_reason: "subscription_cycle", customer: "cus_1", subscription: "sub_old" } },
});
check("a renewal in the old API shape rolls the allowance",
  r.status === 200 && lastRpc("billing_apply_plan")?.p_subscription === "sub_old"
  && lastRpc("billing_apply_plan")?.p_reset_period === true, JSON.stringify(lastRpc("billing_apply_plan")));

calls.length = 0;
r = await send({
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_2", billing_reason: "subscription_cycle", customer: "cus_1",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_basil" } } } },
});
check("a renewal in the Basil API shape rolls the allowance (invoice.parent)",
  r.status === 200 && lastRpc("billing_apply_plan")?.p_subscription === "sub_basil", JSON.stringify(lastRpc("billing_apply_plan")));
check("the account is looked up by that subscription id",
  accountQueries().some((c) => c.url.includes("sub_basil")), accountQueries().map((c) => c.url).join(" "));

calls.length = 0;
r = await send({
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_3", billing_reason: "subscription_cycle", customer: "cus_1",
    lines: { data: [{ parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_line" } } }] } } },
});
check("a renewal that carries the subscription only on its line items still rolls",
  r.status === 200 && lastRpc("billing_apply_plan")?.p_subscription === "sub_line", JSON.stringify(lastRpc("billing_apply_plan")));

// The first invoice must NOT roll: checkout already started the period.
calls.length = 0;
r = await send({
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_4", billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_basil" } } } },
});
check("the first invoice does not reset a period that is seconds old",
  r.status === 200 && rpc("billing_apply_plan").length === 0);

// An invoice with no subscription at all is ignored, not an error.
calls.length = 0;
r = await send({ type: "invoice.payment_succeeded", data: { object: { id: "in_5", billing_reason: "manual" } } });
check("a one-off invoice with no subscription is ignored cleanly",
  r.status === 200 && rpc("billing_apply_plan").length === 0);

// ── 5 · A failed payment, Basil shape ───────────────────────────────
calls.length = 0;
r = await send({
  type: "invoice.payment_failed",
  data: { object: { id: "in_6", parent: { subscription_details: { subscription: "sub_basil" } } } },
});
check("a failed payment in the Basil shape marks the account past due",
  r.status === 200 && lastRpc("billing_payment_failed")?.p_subscription === "sub_basil", JSON.stringify(lastRpc("billing_payment_failed")));

// ── 6 · Cancellation ────────────────────────────────────────────────
calls.length = 0;
r = await send({ type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
check("a cancelled subscription ends the plan",
  r.status === 200 && lastRpc("billing_subscription_ended")?.p_subscription === "sub_1"
  && lastRpc("billing_subscription_ended")?.p_status === "cancelled", JSON.stringify(lastRpc("billing_subscription_ended")));

calls.length = 0;
r = await send({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "unpaid" } } });
check("an unpaid subscription ends the plan too",
  r.status === 200 && lastRpc("billing_subscription_ended")?.p_status === "unpaid");

calls.length = 0;
r = await send({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active",
  customer: "cus_1", items: { data: [{ price: { id: "price_scale" } }] } } } });
check("an upgrade in Stripe becomes an upgrade in the product, without resetting the period",
  r.status === 200 && lastRpc("billing_apply_plan")?.p_plan === "scale"
  && lastRpc("billing_apply_plan")?.p_reset_period === false, JSON.stringify(lastRpc("billing_apply_plan")));

// ── 7 · Stripe sends everything twice ───────────────────────────────
calls.length = 0;
const dup = { type: "customer.subscription.deleted", data: { object: { id: "sub_dup" } } };
await send(dup, { id: "evt_dup" });
const before = rpc("billing_subscription_ended").length;
r = await send(dup, { id: "evt_dup" });
check("a repeated delivery is acknowledged but not applied twice",
  r.status === 200 && r.text === "ok (duplicate)" && rpc("billing_subscription_ended").length === before, `${r.text}`);

// ── 8 · When the database is unhappy, Stripe must retry ─────────────
calls.length = 0;
state.rpcFails = "billing_subscription_ended";
r = await send({ type: "customer.subscription.deleted", data: { object: { id: "sub_err" } } });
check("a database failure returns 500 so Stripe retries", r.status === 500, `${r.status} ${r.text}`);
check("and the event is un-recorded, so the retry is not skipped as a duplicate",
  calls.some((c) => c.method === "DELETE" && c.url.includes("stripe_events")));
state.rpcFails = "";

calls.length = 0;
state.seenFails = true;
r = await send({ type: "customer.subscription.deleted", data: { object: { id: "sub_err2" } } });
check("if the event cannot even be recorded, nothing is applied and Stripe retries",
  r.status === 500 && rpc("billing_subscription_ended").length === 0, `${r.status}`);
state.seenFails = false;

// ── 9 · An event we do not handle ───────────────────────────────────
calls.length = 0;
r = await send({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
check("an event we do not handle is acknowledged and ignored", r.status === 200 && r.text === "ok");

summary("webhook");
