import { calls, onRequest, J, check, summary, sleep } from "./harness.ts";

const SECRET = "sb_secret_testtesttesttesttest";
const state: { jobs: any[]; stageStatus: Record<number, number>; truncateOnce: Record<number, boolean> } =
  { jobs: [], stageStatus: {}, truncateOnce: {} };

const rowOrRows = (h: Headers, row: unknown) => (h.get("accept") ?? "").includes("pgrst.object") ? row : [row];
const STAGE_KEYS: Record<number, string> = { 1: "extracted", 2: "cost", 3: "risks", 4: "compliance", 5: "insights" };

onRequest((u, body, h) => {
  if (u.hostname === "sb.test") {
    if (u.pathname === "/rest/v1/rpc/claim_job") return J(200, state.jobs.shift() ?? null);
    if (u.pathname === "/rest/v1/accounts") return J(200, rowOrRows(h, { data_region: "eu" }));
    if (u.pathname.startsWith("/rest/v1/rpc/") || u.pathname.startsWith("/rest/v1/")) return J(200, null);
  }
  if (u.hostname.startsWith("bedrock-runtime.")) {
    const task: string = body?.messages?.[0]?.content?.[1]?.text ?? body?.messages?.[0]?.content ?? "";
    const n = Number((/STAGE (\d)/.exec(String(task)) ?? [])[1] ?? 1);
    if (state.stageStatus[n]) return J(state.stageStatus[n], { message: "Malformed input request" }, { "x-amzn-errortype": "ValidationException:x" });
    if (state.truncateOnce[n] && !String(task).includes("previous attempt was too long")) {
      return J(200, { content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 8000 } });
    }
    const key = STAGE_KEYS[n] ?? "text";
    return J(200, { content: [{ type: "text", text: "```json\n" + JSON.stringify({ [key]: { stage: n } }) + "\n```" }],
      stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 900, cache_read_input_tokens: n > 1 ? 4000 : 0, cache_creation_input_tokens: n === 1 ? 4000 : 0 } });
  }
  return null;
});

await import("../../supabase/functions/job-worker/index.ts");
await sleep(200);

const wake = (key?: string) => fetch("http://localhost:8000/", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key, apikey: key } : {}) }, body: "{}",
});
const rpc = (name: string) => calls.filter((c) => c.url.endsWith("/rpc/" + name));
const bedrock = () => calls.filter((c) => c.url.includes("bedrock-runtime."));
const waitFor = async (pred: () => boolean, ms = 5000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await sleep(25); };

const v13job = (id: string) => ({
  id, account_id: "acct-1", contract_id: "c1", kind: "analysis", enqueued_at: new Date().toISOString(), started_at: new Date().toISOString(),
  payload: { v: 2, context: "SHARED CONTRACT TEXT", stages: [1, 2, 3, 4, 5].map((n) => ({ n, label: "Stage " + n, task: `STAGE ${n} task`, max_tokens: 8000 })) },
});

console.log("worker");
let r = await wake();
check("no key → 401", r.status === 401); await r.body?.cancel();
r = await wake("sb_publishable_testtesttesttest");
check("publishable key → 401 (only secret keys may wake it)", r.status === 401); await r.body?.cancel();

// Full five-stage job
calls.length = 0; state.jobs = [v13job("job-1")];
r = await wake(SECRET);
check("secret key → 202 straight away", r.status === 202); await r.body?.cancel();
await waitFor(() => rpc("complete_job").length > 0);
const b = bedrock();
check("all five stages called", b.length === 5, String(b.length));
check("every stage goes to London / EU profile", b.every((c) => c.url === "https://bedrock-runtime.eu-west-2.amazonaws.com/model/eu.anthropic.claude-sonnet-5/invoke"));
check("documents block identical in every stage and marked cacheable",
  b.every((c) => c.body.messages[0].content[0].text === "SHARED CONTRACT TEXT" && c.body.messages[0].content[0].cache_control?.type === "ephemeral"));
const res = rpc("complete_job")[0]?.body?.p_result ?? {};
check("merged result holds every stage", ["extracted", "cost", "risks", "compliance", "insights"].every((k) => k in res), JSON.stringify(res));
check("no partial flag on a clean run", !("partial" in res));
check("nothing sent to api.anthropic.com", !calls.some((c) => c.url.includes("api.anthropic.com")));

// Stage 3 fails permanently → partial
calls.length = 0; state.jobs = [v13job("job-2")]; state.stageStatus = { 3: 400 };
await (await wake(SECRET)).body?.cancel();
await waitFor(() => rpc("complete_job").length > 0 || rpc("fail_job").length > 0);
const res2 = rpc("complete_job")[0]?.body?.p_result ?? {};
check("a failed later stage keeps the rest and says so", Array.isArray(res2.partial) && /Stage 3/.test(res2.partial[0]) && "insights" in res2, JSON.stringify(res2).slice(0, 200));

// Stage 1 fails → job fails, not retryable
calls.length = 0; state.jobs = [v13job("job-3")]; state.stageStatus = { 1: 400 };
await (await wake(SECRET)).body?.cancel();
await waitFor(() => rpc("fail_job").length > 0);
const f = rpc("fail_job")[0]?.body;
check("stage-one failure fails the job (no retry on a 400)", f?.p_job_id === "job-3" && f?.p_retryable === false && rpc("complete_job").length === 0, JSON.stringify(f));

// Throttling on a later stage → whole job retried
calls.length = 0; state.jobs = [v13job("job-4")]; state.stageStatus = { 2: 429 };
await (await wake(SECRET)).body?.cancel();
await waitFor(() => rpc("fail_job").length > 0, 15000);
check("throttling → job handed back for retry", rpc("fail_job")[0]?.body?.p_retryable === true);

// Truncation → retried once, briefly
await sleep(50);
calls.length = 0; state.jobs = [v13job("job-5")]; state.stageStatus = {}; state.truncateOnce = { 2: true };
await (await wake(SECRET)).body?.cancel();
await waitFor(() => rpc("complete_job").length > 0 || rpc("fail_job").length > 0);
const briefs = bedrock().filter((c) => /previous attempt was too long/.test(c.body.messages[0].content[1].text));
check("a truncated stage is retried once, asking for brevity", briefs.length === 1 && rpc("complete_job").length === 1, `briefs=${briefs.length} fail=${JSON.stringify(rpc("fail_job")[0]?.body)}`);

// Legacy payload queued before the upgrade
calls.length = 0; state.truncateOnce = {};
state.jobs = [{ id: "job-6", account_id: "acct-1", contract_id: "c1", kind: "analysis", payload: { prompt: "STAGE 1 legacy", max_tokens: 8000 } }];
await (await wake(SECRET)).body?.cancel();
await waitFor(() => rpc("complete_job").length > 0);
check("pre-v13 queued job still completes (one call)", bedrock().length === 1 && "extracted" in (rpc("complete_job")[0]?.body?.p_result ?? {}));

summary("worker");
