// ContractIQ Platform · Supabase Edge Function · anthropic-proxy
// ---------------------------------------------------------------
// The ONLY place the Anthropic API key exists. The browser never sees it.
//
// WHAT CHANGED IN THIS VERSION, AND WHY IT MATTERS
//
//   Before: deployed with --no-verify-jwt, so anyone who found the URL —
//   and it is visible in every user's browser network tab — could spend
//   the Anthropic balance. The only guard was a counter held in this
//   function's memory: shared across every customer, and reset to zero
//   every time the function went cold.
//
//   Now: the caller must present a valid Supabase session. Their account
//   is resolved from that session, credits are RESERVED before the model
//   is called and settled only if it answers, and the hourly limit is per
//   account and lives in the database.
//
// DEPLOY
//   Supabase → Edge Functions → Deploy a new function → Via Editor
//   Name it  anthropic-proxy  and paste this file in.
//   Enforce JWT verification: ON.      ← this is the fix. Leave it on.
//
// SECRETS (Edge Functions → Secrets)
//   ANTHROPIC_API_KEY = sk-ant-...
//   ALLOWED_ORIGIN    = https://contractiqplatform.co.uk    (no path, no trailing slash)
//   ANTHROPIC_MODEL   = claude-sonnet-5                     (optional)
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically. You do not add those yourself.
//
// The /demo build never calls this function at all — it serves canned
// responses — so turning JWT verification on does not break the demo.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const MODEL          = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// What each kind of call costs. These mirror pricing.html and the credit
// table in the app. Re-running an analysis inside the revision window is
// free, which the app signals by sending kind "revision" with cost 0.
const COST: Record<string, number> = { analysis: 10, cedric: 2, revision: 0 };

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN || origin || "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // One preflight a day instead of five per analysis. Without this the
  // browser asks permission before every call, and each OPTIONS is another
  // chance to hit a worker that is booting — which returns 502 and shows
  // up as "Failed to fetch" with the POST never sent.
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // Answer the preflight first and as cheaply as possible, before any
  // check that could throw. A failed preflight blocks the real request.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
    return json(403, { error: "Origin not allowed" });
  }
  if (!ANTHROPIC_KEY) {
    return json(500, { error: "Server is missing ANTHROPIC_API_KEY" });
  }

  // ── 1 · Who is calling ────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Please sign in before running analysis." });
  }

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) {
    return json(401, { error: "Your session has expired. Sign in again and retry." });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid request" }); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json(400, { error: "No messages supplied" });

  const kind = ["analysis", "cedric", "revision"].includes(String(body.kind))
    ? String(body.kind) : "cedric";
  const cost = COST[kind] ?? 0;
  const contractId = body.contract_id ? String(body.contract_id).slice(0, 120) : null;

  // One analysis is five calls to the model, one per stage. They share a
  // run_id, so the run is authorised and charged ONCE — not five times —
  // and a run that dies at stage four costs the customer nothing.
  const runId = body.run_id ? String(body.run_id).slice(0, 80) : null;
  // The last stage settles the charge. Anything earlier leaves the hold
  // open, so the credits are committed only when the whole run lands.
  const isFinal = body.final === true || kind === "cedric";

  // ── 2 · Which account, and may it spend? ──────────────────────
  // The account comes from the caller's own membership row, read with
  // THEIR token, so Row Level Security decides it — never from the
  // request body, which a modified client controls.
  const { data: membership } = await asUser
    .from("account_members").select("account_id").limit(1).maybeSingle();

  const accountId = membership?.account_id;
  if (!accountId) {
    return json(403, { error: "This sign-in is not attached to a workspace yet." });
  }

  const { data: auth, error: authErr } = await asUser.rpc("authorise_ai_call", {
    p_account_id:  accountId,
    p_kind:        kind,
    p_cost:        cost,
    p_contract_id: contractId,
    p_run_id:      runId,
  });

  if (authErr) {
    console.error("authorise_ai_call failed", authErr.message);
    return json(500, { error: "Could not check your credit balance. Nothing has been charged." });
  }

  if (!auth?.ok) {
    // 402 for "out of credits", 429 for "too fast" — the app shows a
    // different, actionable panel for each.
    const status = auth?.reason === "rate_limit" ? 429 : 402;
    return json(status, {
      error:     auth?.message ?? "This action is not available right now.",
      reason:    auth?.reason,
      needed:    auth?.needed,
      available: auth?.available,
      limit:     auth?.limit,
    });
  }

  const holdId: string | null = auth.hold_id ?? null;

  // Settling and releasing must happen whatever the caller's own RLS
  // would allow, so they go through the service role. This client is
  // created AFTER authorisation, and is never used to decide anything.
  const asService = SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : asUser;

  const release = async () => {
    if (holdId) await asService.rpc("release_credit_hold", { p_hold_id: holdId });
  };
  // Only the final stage of a run commits the charge. Earlier stages
  // leave the hold open: the credits are already unspendable, so the
  // balance is honest, but nothing is billed until the run finishes.
  const settle = async () => {
    if (holdId && isFinal) await asService.rpc("settle_credit_hold", { p_hold_id: holdId });
  };

  // ── 3 · Call the model ────────────────────────────────────────
  try {
    const payload = {
      model: MODEL,
      // A full contract analysis routinely needs 5-7k output tokens.
      // Capping at 4,000 truncated the JSON mid-object after roughly
      // 45 seconds of generation, which surfaced as an opaque failure.
      max_tokens: Math.min(Number(body.max_tokens) || 2000, 16000),
      ...(body.system ? { system: String(body.system) } : {}),
      messages,
    };

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      // Anthropic refused. The customer did not get an answer, so the
      // customer does not pay for one.
      await release();
      console.error(`anthropic ${upstream.status}`, data?.error?.type ?? "");
      return json(upstream.status, {
        ...data,
        _charged: false,
        error: data?.error?.message ?? `Anthropic returned ${upstream.status}`,
      });
    }

    // A truncated answer is a failed answer: the app cannot parse it.
    // Say so plainly and charge nothing, rather than billing for a
    // response that will throw when it is read.
    if (data?.stop_reason === "max_tokens") {
      await release();
      return json(502, {
        ...data,
        _charged: false,
        error: "The model ran out of room before finishing. Nothing has been charged. Try a shorter document or fewer pages.",
      });
    }

    await settle();

    if (data?.usage) {
      const inTok = data.usage.input_tokens ?? 0;
      const outTok = data.usage.output_tokens ?? 0;
      const usd = (inTok * 3) / 1e6 + (outTok * 15) / 1e6;
      console.log(`acct:${accountId} kind:${kind} run:${runId ?? "-"} in:${inTok} out:${outTok} ~$${usd.toFixed(4)} settled:${isFinal}`);
    }

    return json(200, {
      ...data,
      _charged: isFinal ? ((auth.from_plan ?? 0) + (auth.from_bolton ?? 0)) : 0,
      _credits_left: auth.credits_left ?? null,
    });
  } catch (e) {
    await release();
    console.error("proxy error", e);
    return json(502, {
      error: "The analysis service could not be reached. Nothing has been charged — please try again.",
      _charged: false,
      detail: String(e),
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
   STILL NOT DONE HERE, deliberately

   PROMPT CACHING. Cedric re-sends the whole document context with
   every question. Anthropic's prompt caching would cut that to roughly
   a third of the cost. It is a pure saving with no behaviour change,
   and it is the next thing worth doing to this file.
   ═══════════════════════════════════════════════════════════════ */
