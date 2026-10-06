// ContractIQ Platform · Supabase Edge Function · anthropic-proxy
// ---------------------------------------------------------------
// The ONLY way the app reaches the AI model. The browser never holds a key.
//
// The name is historical: the app builds its URL from it, so it stays.
// Since v13 the model is reached through AMAZON BEDROCK, not Anthropic's
// own API. That is a data-protection decision, not a cost one:
//
//   · Bedrock does not pass prompts or answers to Anthropic.
//   · Bedrock does not train on prompts or answers. Zero data retention is a per-region account setting: on in 5 of the 7 regions this route can use (see CHANGES_v14.md).
//   · The EU route (eu.anthropic.claude-sonnet-5, called from London)
//     keeps processing inside AWS regions in the UK and EEA.
//
// The "global" route is refused outright: it is cheaper, but it may run
// anywhere in the world, and no promise on the website would survive it.
//
// DEPLOY
//   Supabase → Edge Functions → Deploy a new function → Via Editor
//   Name it  anthropic-proxy  and paste this file in.
//   Enforce JWT verification: ON. Every caller is a signed-in person.
//
// SECRETS (Edge Functions → Secrets)
//   AWS_ACCESS_KEY_ID      = the access key of the contractiq-bedrock IAM user
//   AWS_SECRET_ACCESS_KEY  = its secret
//   ALLOWED_ORIGIN         = https://contractiqplatform.co.uk   (no path, no trailing slash)
//   Optional, with safe defaults:
//   BEDROCK_REGION_EU = eu-west-2      BEDROCK_MODEL_EU = eu.anthropic.claude-sonnet-5
//   BEDROCK_REGION_US = us-east-1      BEDROCK_MODEL_US = us.anthropic.claude-sonnet-5
//   AI_PROVIDER       = bedrock        (set to "anthropic" ONLY to roll back
//                                       in an emergency; it also needs
//                                       ANTHROPIC_API_KEY, and it breaks the
//                                       promises in the Legal Centre)
//
// SUPABASE_URL and the project keys are injected automatically.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { AwsClient } from "npm:aws4fetch@1.0.20";

// ── Project keys ────────────────────────────────────────────────
// Projects created in 2026 use sb_publishable_/sb_secret_ keys, injected as
// JSON dictionaries. Prefer those; the legacy single keys are the fallback.
function firstKey(jsonDict: string | undefined): string {
  if (!jsonDict) return "";
  try {
    const d = JSON.parse(jsonDict);
    if (typeof d === "string") return d;
    return String(d.default ?? Object.values(d)[0] ?? "");
  } catch { return ""; }
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY     = firstKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")) || (Deno.env.get("SUPABASE_ANON_KEY") ?? "");
const SERVICE_KEY  = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const FN_REGION    = Deno.env.get("SB_REGION") ?? "unknown";

// ═══════════════════════════════════════════════════════════════
//  AI PROVIDER — identical block in job-worker/index.ts
// ═══════════════════════════════════════════════════════════════
const AWS_KEY_ID    = Deno.env.get("AWS_ACCESS_KEY_ID") ?? "";
const AWS_SECRET    = Deno.env.get("AWS_SECRET_ACCESS_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const PROVIDER      = (Deno.env.get("AI_PROVIDER") ?? "bedrock").trim().toLowerCase();

type Route = { region: string; model: string };
const ROUTES: Record<string, Route> = {
  eu: { region: Deno.env.get("BEDROCK_REGION_EU") ?? "eu-west-2",
        model:  Deno.env.get("BEDROCK_MODEL_EU")  ?? "eu.anthropic.claude-sonnet-5" },
  us: { region: Deno.env.get("BEDROCK_REGION_US") ?? "us-east-1",
        model:  Deno.env.get("BEDROCK_MODEL_US")  ?? "us.anthropic.claude-sonnet-5" },
};

// US dollars per million tokens. Bedrock's EU and US routes carry a 10%
// premium over global routing; that premium is the price of a promise
// about where the data goes. Used for the cost line in the logs only.
const PRICE = PROVIDER === "anthropic"
  ? { in: 2.00, out: 10.0, write: 2.50, read: 0.20 }
  : { in: 2.20, out: 11.0, write: 2.75, read: 0.22 };

function costUsd(u: Record<string, number> = {}): number {
  return ((u.input_tokens ?? 0) * PRICE.in + (u.output_tokens ?? 0) * PRICE.out
    + (u.cache_creation_input_tokens ?? 0) * PRICE.write
    + (u.cache_read_input_tokens ?? 0) * PRICE.read) / 1e6;
}

// A misconfiguration that would send data outside the promised regions
// is an error, not a warning.
function routeProblem(r: Route): string | null {
  if (!/^(eu|us)\./.test(r.model)) {
    return `Refusing model "${r.model}": only the eu. and us. Bedrock routes are allowed. The global route can process data anywhere in the world.`;
  }
  return null;
}

export type ModelCall = {
  system?: unknown;
  messages: unknown[];
  max_tokens: number;
  dataRegion?: string;
  timeoutMs?: number;
};
export type ModelResult = { status: number; data: any };

async function callModel(c: ModelCall): Promise<ModelResult> {
  const timeout = AbortSignal.timeout(c.timeoutMs ?? 140_000);

  if (PROVIDER === "anthropic") {
    if (!ANTHROPIC_KEY) return { status: 500, data: { error: { type: "config", message: "Server is missing ANTHROPIC_API_KEY (AI_PROVIDER is set to anthropic)." } } };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: timeout,
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5",
        max_tokens: c.max_tokens,
        ...(c.system ? { system: c.system } : {}),
        messages: c.messages,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  if (!AWS_KEY_ID || !AWS_SECRET) {
    return { status: 500, data: { error: { type: "config", message: "Server is missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY." } } };
  }
  const route = ROUTES[c.dataRegion === "us" ? "us" : "eu"];
  const bad = routeProblem(route);
  if (bad) return { status: 500, data: { error: { type: "config", message: bad } } };

  const aws = new AwsClient({
    accessKeyId: AWS_KEY_ID, secretAccessKey: AWS_SECRET,
    service: "bedrock", region: route.region,
    // aws4fetch retries throttling and 5xx by itself, ten times by default.
    // Two short retries is enough; beyond that the caller's own retry
    // (the app, or the queue) is the better judge.
    retries: 2, initRetryMs: 400,
  });
  const url = `https://bedrock-runtime.${route.region}.amazonaws.com/model/${encodeURIComponent(route.model)}/invoke`;
  const res = await aws.fetch(url, {
    method: "POST",
    signal: timeout,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: c.max_tokens,
      ...(c.system ? { system: c.system } : {}),
      messages: c.messages,
    }),
  });
  const raw = await res.json().catch(() => ({}));
  if (res.ok) return { status: 200, data: raw };

  // Bedrock errors are { message } plus a type header. Reshape them to the
  // { error: { type, message } } form the rest of the code already reads.
  const type = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0] || `HTTP ${res.status}`;
  let message = String(raw?.message ?? raw?.Message ?? `Bedrock returned ${res.status}`);
  if (res.status === 403) {
    message = "Amazon Bedrock refused the request (access denied). Check the contractiq-bedrock IAM user's policy, that the Anthropic use-case form was submitted, and that the AWS keys in Supabase secrets are current.";
  }
  if (type === "ResourceNotFoundException" || /model identifier is invalid|inference profile/i.test(message)) {
    message = `Bedrock does not recognise the model "${route.model}" in ${route.region}. ${message}`;
  }
  return { status: res.status, data: { error: { type, message } } };
}
// ═══════════════════════════════════════════════════════════════

// Cedric re-sends the whole contract with every question. Marking that
// block as cacheable means a follow-up within five minutes reads it at a
// tenth of the price. Below Bedrock's 1,024-token minimum the marker is
// silently ignored, so it is always safe to add.
function cacheableSystem(system: unknown): unknown {
  if (typeof system === "string" && system.length > 4000) {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return system;
}

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN || origin || "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // One preflight a day instead of five per analysis.
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

// A single request carrying more than this is not something the app sends
// (documents are clipped to 55,000 characters). Refuse it before it costs.
const MAX_BODY_BYTES = 1_500_000;

serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
    return json(403, { error: "Origin not allowed" });
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
  if (userErr || !userData?.user) {
    return json(401, { error: "Your session has expired. Sign in again and retry." });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "That request is too large to analyse in one go. Split the documents across two records." });
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: "Invalid request" }); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json(400, { error: "No messages supplied" });

  const requested = String(body.kind ?? "cedric");
  const isAnalysis = requested === "analysis" || requested === "revision";
  const contractId = body.contract_id ? String(body.contract_id).slice(0, 120) : null;
  const runId = body.run_id ? String(body.run_id).slice(0, 80) : null;
  // The last stage settles the charge. Cedric is always one call.
  const isFinal = body.final === true || !isAnalysis;

  // ── 2 · Which account, and may it spend? ──────────────────────
  // The account comes from the caller's own membership row, read with
  // THEIR token, so Row Level Security decides it — never the request body.
  const { data: membership } = await asUser
    .from("account_members").select("account_id").limit(1).maybeSingle();
  const accountId = membership?.account_id;
  if (!accountId) return json(403, { error: "This sign-in is not attached to a workspace yet." });

  // What an analysis costs is decided HERE, not by the browser. Before
  // v13 the app could send kind "revision" and the proxy took its word
  // for it — a modified client could have had every analysis for free.
  let cost = 2;
  if (isAnalysis) {
    let free = false;
    if (contractId) {
      const { data: f } = await asUser.rpc("reanalysis_is_free", {
        p_account_id: accountId, p_contract_id: contractId,
      });
      free = f === true;
    }
    cost = free ? 0 : 10;
  }

  const { data: auth, error: authErr } = await asUser.rpc("authorise_ai_call", {
    p_account_id:  accountId,
    p_kind:        isAnalysis ? "analysis" : "cedric",   // the hourly cap counts AI calls, free or not
    p_cost:        cost,
    p_contract_id: contractId,
    p_run_id:      isAnalysis ? runId : null,
  });
  if (authErr) {
    console.error("authorise_ai_call failed", authErr.message);
    return json(500, { error: "Could not check your credit balance. Nothing has been charged." });
  }
  if (!auth?.ok) {
    const status = auth?.reason === "rate_limit" ? 429 : 402;
    return json(status, {
      error: auth?.message ?? "This action is not available right now.",
      reason: auth?.reason, needed: auth?.needed, available: auth?.available, limit: auth?.limit,
    });
  }
  const holdId: string | null = auth.hold_id ?? null;

  const asService = SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : asUser;
  const release = async () => { if (holdId) await asService.rpc("release_credit_hold", { p_hold_id: holdId }); };
  const settle  = async () => { if (holdId && isFinal) await asService.rpc("settle_credit_hold", { p_hold_id: holdId }); };

  // Which Bedrock route this workspace uses. EU unless CodeIQ has moved
  // the account to the US route by hand (see the go-live guide).
  let dataRegion = "eu";
  try {
    const { data: acct } = await asService.from("accounts").select("data_region").eq("id", accountId).maybeSingle();
    if (acct?.data_region === "us") dataRegion = "us";
  } catch { /* column missing until MIGRATION_007 runs — EU is the safe default */ }

  // ── 3 · Call the model ────────────────────────────────────────
  try {
    const { status, data } = await callModel({
      system: isAnalysis ? body.system : cacheableSystem(body.system),
      messages,
      max_tokens: Math.min(Number(body.max_tokens) || 2000, 16000),
      dataRegion,
    });

    if (status !== 200) {
      await release();
      console.error(`model ${status}`, data?.error?.type ?? "", `fn:${FN_REGION}`);
      return json(status >= 400 && status < 600 ? status : 502, {
        ...data, _charged: false,
        error: data?.error?.message ?? `The AI service returned ${status}`,
      });
    }

    if (data?.stop_reason === "max_tokens") {
      await release();
      return json(502, {
        ...data, _charged: false,
        error: "The model ran out of room before finishing. Nothing has been charged. Try a shorter document or fewer pages.",
      });
    }

    await settle();

    // Metadata only. Never the prompt, never the answer.
    const u = data?.usage ?? {};
    console.log(`acct:${accountId} kind:${isAnalysis ? "analysis" : "cedric"} cost:${cost} run:${runId ?? "-"} ` +
      `route:${PROVIDER}/${dataRegion} fn:${FN_REGION} in:${u.input_tokens ?? 0} out:${u.output_tokens ?? 0} ` +
      `cw:${u.cache_creation_input_tokens ?? 0} cr:${u.cache_read_input_tokens ?? 0} ~$${costUsd(u).toFixed(4)} settled:${isFinal}`);

    return json(200, {
      ...data,
      _charged: isFinal ? ((auth.from_plan ?? 0) + (auth.from_bolton ?? 0)) : 0,
      _credits_left: auth.credits_left ?? null,
    });
  } catch (e) {
    await release();
    const timedOut = (e as Error)?.name === "TimeoutError";
    console.error("proxy error", timedOut ? "timeout" : String(e));
    return json(timedOut ? 504 : 502, {
      error: timedOut
        ? "The AI service took too long to answer. Nothing has been charged — please try again."
        : "The analysis service could not be reached. Nothing has been charged — please try again.",
      _charged: false,
    });
  }
});
