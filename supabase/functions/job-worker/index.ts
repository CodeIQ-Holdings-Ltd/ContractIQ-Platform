// ContractIQ · Supabase Edge Function · job-worker
// ---------------------------------------------------------------
// The background worker. pg_cron wakes it every few seconds when there is
// work waiting; it claims one job, runs it, and writes the result back.
//
// WHAT CHANGED IN v13, AND WHY
//
//   1. ALL FIVE STAGES. The queue used to run only stage one of the
//      analysis (the extraction) while charging for the whole thing, so a
//      background analysis came back without cost, risk, compliance,
//      knowledge or insights. It now runs the same five stages the
//      browser does, sharing one cached copy of the documents.
//   2. AMAZON BEDROCK, EU route — see the block below.
//   3. IT CHECKS WHO IS CALLING. It used to rely on Supabase's gateway
//      JWT check, which refuses the new sb_secret_ keys, so on a 2026
//      project the dispatcher could never wake it. Deploy with JWT
//      verification OFF; the function checks the project's secret key
//      itself, and turns everyone else away.
//   4. IT ANSWERS AT ONCE AND WORKS IN THE BACKGROUND. A five-stage run
//      takes one to three minutes; Supabase cuts off any request that has
//      not answered in 150 seconds. EdgeRuntime.waitUntil keeps working
//      after the reply, up to the plan's 400-second limit.
//
// DEPLOY
//   Supabase → Edge Functions → Deploy a new function → Via Editor
//   Name:  job-worker      Enforce JWT verification: OFF (see point 3)
//   Uses the same AWS secrets as anthropic-proxy. Nothing extra to add.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { AwsClient } from "npm:aws4fetch@1.0.20";

function firstKey(jsonDict: string | undefined): string {
  if (!jsonDict) return "";
  try {
    const d = JSON.parse(jsonDict);
    if (typeof d === "string") return d;
    return String(d.default ?? Object.values(d)[0] ?? "");
  } catch { return ""; }
}
function allKeys(jsonDict: string | undefined): string[] {
  if (!jsonDict) return [];
  try {
    const d = JSON.parse(jsonDict);
    return (typeof d === "string" ? [d] : Object.values(d)).map(String).filter(Boolean);
  } catch { return []; }
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const FN_REGION    = Deno.env.get("SB_REGION") ?? "unknown";

// The keys allowed to wake this worker: the project's own secret keys.
const TRUSTED_KEYS = [
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  ...allKeys(Deno.env.get("SUPABASE_SECRET_KEYS")),
].filter((k) => k.length > 20);

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

// One five-stage analysis takes one to three minutes. Supabase Pro allows
// 400 seconds per invocation, so one job per wake-up is the safe number;
// the dispatcher wakes another worker for the next job in parallel.
const MAX_JOBS_PER_RUN = Number(Deno.env.get("MAX_JOBS_PER_RUN") ?? "1");
const WORKER_ID = `worker-${crypto.randomUUID().slice(0, 8)}`;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── Circuit breaker ───────────────────────────────────────────
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60_000;
const breakerOpen = () => Date.now() < breakerOpenUntil;
function recordSuccess() { consecutiveFailures = 0; breakerOpenUntil = 0; }
function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(`circuit breaker OPEN for ${BREAKER_COOLDOWN_MS / 1000}s`);
  }
}

// A 400 fails identically forever; 429 and 5xx are worth another go.
function isRetryable(status: number, message: string): boolean {
  if (status === 429 || status === 408 || status >= 500) return true;
  return /network|fetch failed|timeout|ECONN|throttl/i.test(message);
}

function modelError(status: number, data: any): Error {
  const err = new Error(data?.error?.message ?? `HTTP ${status}`) as Error & { status?: number; fatal?: boolean };
  err.status = status;
  if (data?.error?.type === "config") err.fatal = true;   // retrying a missing key will not help
  return err;
}

const textOf = (data: any) => (data?.content ?? [])
  .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");

// The model is asked for JSON. Parse defensively: fences, prose either
// side, trailing commas.
function extractJson(text: string) {
  let t = (text ?? "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  try { return JSON.parse(t); } catch { /* one more try */ }
  return JSON.parse(t.replace(/,\s*([}\]])/g, "$1"));
}

const BRIEF = "\n\nIMPORTANT: your previous attempt was too long and was discarded. Return AT MOST HALF the number of items in every array, and keep every string to one short sentence.";

type Usage = Record<string, number>;
function addUsage(total: Usage, u: Usage = {}) {
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    total[k] = (total[k] ?? 0) + (u[k] ?? 0);
  }
}

async function progress(jobId: string, pct: number, note: string) {
  try { await db.rpc("report_job_progress", { p_job_id: jobId, p_progress: pct, p_note: note }); } catch { /* cosmetic */ }
}

async function processJob(job: Record<string, any>) {
  const t0 = Date.now();
  const p = job.payload ?? {};
  const usage: Usage = {};

  let dataRegion = "eu";
  try {
    const { data: acct } = await db.from("accounts").select("data_region").eq("id", job.account_id).maybeSingle();
    if (acct?.data_region === "us") dataRegion = "us";
  } catch { /* EU is the safe default */ }

  let result: Record<string, unknown>;

  if (typeof p.context === "string" && Array.isArray(p.stages) && p.stages.length) {
    // ── v13 payload: shared documents + one short task per stage ──
    const merged: Record<string, unknown> = {};
    const partial: string[] = [];
    const n = p.stages.length;

    for (let i = 0; i < n; i++) {
      const st = p.stages[i] ?? {};
      await progress(job.id, Math.round(8 + (i / n) * 84), String(st.label ?? `Stage ${i + 1}`));
      const run = async (task: string) => {
        const { status, data } = await callModel({
          messages: [{
            role: "user",
            content: [
              // Identical in all five calls, so stages two to five read it
              // from the cache at a tenth of the price.
              { type: "text", text: p.context, cache_control: { type: "ephemeral" } },
              { type: "text", text: task },
            ],
          }],
          max_tokens: Math.min(Number(st.max_tokens) || 8000, 16000),
          dataRegion,
          timeoutMs: 150_000,
        });
        if (status !== 200) throw modelError(status, data);
        addUsage(usage, data?.usage);
        return data;
      };

      try {
        let data = await run(String(st.task ?? ""));
        if (data?.stop_reason === "max_tokens") {
          data = await run(String(st.task ?? "") + BRIEF);
          if (data?.stop_reason === "max_tokens") {
            throw new Error("this section is unusually large even when asked to be brief — try splitting the documents across two records.");
          }
        }
        Object.assign(merged, extractJson(textOf(data)));
      } catch (e) {
        const err = e as Error & { status?: number };
        // Stage one is the record itself: without it there is nothing to
        // show, so it fails the job (and releases the credits). A later
        // stage failing keeps what worked and says what is missing.
        if (i === 0) throw err;
        if (err.status && isRetryable(err.status, err.message)) throw err;   // let the queue retry the whole job
        partial.push(`Stage ${st.n ?? i + 1} (${st.label ?? ""}) did not complete: ${err.message}`);
      }
    }
    if (partial.length) merged.partial = partial;
    result = merged;
  } else if (p.prompt || Array.isArray(p.messages)) {
    // ── Pre-v13 payload, queued before the upgrade: one call ──
    await progress(job.id, 35, "Analysing");
    const { status, data } = await callModel({
      system: p.system,
      messages: p.messages ?? [{ role: "user", content: p.prompt }],
      max_tokens: Math.min(p.max_tokens ?? 8000, 16000),
      dataRegion,
      timeoutMs: 150_000,
    });
    if (status !== 200) throw modelError(status, data);
    addUsage(usage, data?.usage);
    result = (job.kind === "analysis" || job.kind === "reanalysis") ? extractJson(textOf(data)) : { text: textOf(data) };
  } else {
    throw Object.assign(new Error("Job payload has nothing to analyse"), { status: 400, fatal: true });
  }

  await progress(job.id, 96, "Saving");
  // complete_job writes the result, charges the reserved credits, and
  // clears the payload so the documents do not linger in the queue.
  const { error } = await db.rpc("complete_job", { p_job_id: job.id, p_result: result });
  if (error) throw Object.assign(new Error(`complete_job: ${error.message}`), { status: 500 });

  await db.from("telemetry_events").insert({
    account_id: job.account_id,
    op: job.kind,
    duration_ms: Date.now() - t0,
    tokens_in: usage.input_tokens ?? null,
    tokens_out: usage.output_tokens ?? null,
    cached_tokens: usage.cache_read_input_tokens ?? null,
    queue_wait_ms: job.started_at
      ? new Date(job.started_at).getTime() - new Date(job.enqueued_at).getTime()
      : null,
    ok: true,
    worker: WORKER_ID,
  });
  console.log(`job ${job.id} (${job.kind}) done in ${Date.now() - t0}ms route:${PROVIDER}/${dataRegion} fn:${FN_REGION} ` +
    `in:${usage.input_tokens ?? 0} out:${usage.output_tokens ?? 0} cr:${usage.cache_read_input_tokens ?? 0} ~$${costUsd(usage).toFixed(4)}`);
}

async function drain() {
  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    if (breakerOpen()) break;
    const { data: job, error: claimErr } = await db.rpc("claim_job", {
      worker: WORKER_ID, kinds: ["analysis", "reanalysis"],
    });
    if (claimErr) { console.error("claim failed", claimErr.message); break; }
    if (!job) break;

    try {
      await processJob(job);
      recordSuccess();
    } catch (e) {
      const err = e as Error & { status?: number; fatal?: boolean };
      const retryable = !err.fatal && isRetryable(err.status ?? 0, err.message ?? "");
      console.error(`job ${job.id} failed (${retryable ? "will retry" : "fatal"}):`, err.message);
      await db.rpc("fail_job", {
        p_job_id: job.id,
        p_error: `${err.status ?? ""} ${err.message}`.trim().slice(0, 500),
        p_retryable: retryable,
      });
      await db.from("telemetry_events").insert({
        account_id: job.account_id, op: job.kind, ok: false,
        error_class: String(err.status ?? "error"), worker: WORKER_ID,
      });
      if (retryable) recordFailure();
    }
  }
}

// Constant-time comparison, so the check does not leak the key one
// character at a time through response timing.
function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve((req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const presented = req.headers.get("apikey") || bearer;
  if (!presented || !TRUSTED_KEYS.some((k) => sameKey(k, presented))) {
    return new Response(JSON.stringify({ error: "Not allowed" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (breakerOpen()) {
    return Response.json({ skipped: true, reason: "circuit breaker open" });
  }

  // Answer the dispatcher now; keep working after the reply.
  const work = drain().catch((e) => console.error("worker crashed", String(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work);
  return Response.json({ worker: WORKER_ID, accepted: true, fn: FN_REGION }, { status: 202 });
});
