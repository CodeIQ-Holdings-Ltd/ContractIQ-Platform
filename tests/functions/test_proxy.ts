import { calls, onRequest, J, check, summary, sleep } from "./harness.ts";

const SCEN = Deno.env.get("SCEN") ?? "main";
const PORT = Number(Deno.env.get("PORT"));
const state = { free: false, region: "eu", bedrock: 200 as number, stop: "end_turn" };

const rowOrRows = (h: Headers, row: unknown) =>
  (h.get("accept") ?? "").includes("pgrst.object") ? row : [row];

onRequest((u, body, h) => {
  if (u.hostname === "sb.test") {
    if (u.pathname === "/auth/v1/user") return J(200, { id: "user-1", email: "a@b.co", aud: "authenticated", role: "authenticated" });
    if (u.pathname === "/rest/v1/account_members") return J(200, rowOrRows(h, { account_id: "acct-1" }));
    if (u.pathname === "/rest/v1/accounts") return J(200, rowOrRows(h, { data_region: state.region }));
    if (u.pathname === "/rest/v1/rpc/reanalysis_is_free") return J(200, state.free);
    if (u.pathname === "/rest/v1/rpc/authorise_ai_call") return J(200, { ok: true, hold_id: "hold-1", from_plan: body.p_cost, from_bolton: 0, credits_left: 90 });
    if (u.pathname.startsWith("/rest/v1/rpc/")) return J(200, null);
  }
  if (u.hostname.startsWith("bedrock-runtime.")) {
    if (state.bedrock !== 200) return J(state.bedrock, { message: "User is not authorized" }, { "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.bedrock/" });
    return J(200, { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: '{"ok":true}' }],
      stop_reason: state.stop, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 } });
  }
  return null;
});

await import("../../supabase/functions/anthropic-proxy/index.ts");
await sleep(200);

const post = (body: unknown, auth = true) => fetch(`http://localhost:${PORT}/`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://contractiqplatform.co.uk", ...(auth ? { authorization: "Bearer user.jwt.token" } : {}) },
  body: JSON.stringify(body),
});
const rpcCalls = (name: string) => calls.filter((c) => c.url.endsWith("/rpc/" + name));
const bedrockCalls = () => calls.filter((c) => c.url.includes("bedrock-runtime."));
const reset = () => { calls.length = 0; state.free = false; state.region = "eu"; state.bedrock = 200; state.stop = "end_turn"; };
const stage = (extra: Record<string, unknown> = {}) => ({
  kind: "analysis", contract_id: "c123", run_id: "run_x", final: false, max_tokens: 8000,
  messages: [{ role: "user", content: [{ type: "text", text: "DOCS", cache_control: { type: "ephemeral" } }, { type: "text", text: "TASK" }] }],
  ...extra,
});

if (SCEN === "main") {
  console.log("proxy · main");
  let r = await post(stage(), false);
  check("no sign-in → 401", r.status === 401); await r.body?.cancel();

  reset();
  r = await post(stage());
  const d = await r.json();
  const b = bedrockCalls()[0];
  check("analysis stage → 200", r.status === 200, JSON.stringify(d).slice(0, 200));
  check("goes to Bedrock in London", !!b && b.url === "https://bedrock-runtime.eu-west-2.amazonaws.com/model/eu.anthropic.claude-sonnet-5/invoke", b?.url);
  check("request is SigV4-signed for bedrock/eu-west-2", /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\/\d{8}\/eu-west-2\/bedrock\/aws4_request/.test(b?.headers.authorization ?? ""), b?.headers.authorization);
  check("Bedrock body has anthropic_version and no model", b?.body?.anthropic_version === "bedrock-2023-05-31" && !("model" in (b?.body ?? {})));
  check("cache marker on the shared documents block is passed through", b?.body?.messages?.[0]?.content?.[0]?.cache_control?.type === "ephemeral");
  check("nothing is sent to api.anthropic.com", !calls.some((c) => c.url.includes("api.anthropic.com")));
  const auth1 = rpcCalls("authorise_ai_call")[0]?.body;
  check("first analysis costs 10, counted as 'analysis'", auth1?.p_cost === 10 && auth1?.p_kind === "analysis", JSON.stringify(auth1));
  check("non-final stage does not settle", rpcCalls("settle_credit_hold").length === 0);

  reset();
  r = await post(stage({ final: true })); await r.json();
  check("final stage settles the hold", rpcCalls("settle_credit_hold").length === 1);

  reset();
  r = await post(stage({ kind: "revision" })); await r.json();
  check("kind 'revision' is NOT free unless the database says so (cost 10)", rpcCalls("authorise_ai_call")[0]?.body?.p_cost === 10);

  reset(); state.free = true;
  r = await post(stage({ kind: "revision" })); await r.json();
  check("genuine re-run inside the window costs 0", rpcCalls("authorise_ai_call")[0]?.body?.p_cost === 0);

  reset(); state.free = true;
  r = await post(stage({ kind: "analysis" })); await r.json();
  check("browser-path re-run sent as 'analysis' is still free when eligible", rpcCalls("authorise_ai_call")[0]?.body?.p_cost === 0);

  reset();
  const longSystem = "You are Cedric. " + "CONTRACT TEXT ".repeat(600);
  r = await post({ kind: "cedric", contract_id: "c123", max_tokens: 1000, system: longSystem, messages: [{ role: "user", content: "When does it renew?" }] });
  await r.json();
  const cb = bedrockCalls()[0]?.body;
  check("Cedric costs 2", rpcCalls("authorise_ai_call")[0]?.body?.p_cost === 2 && rpcCalls("authorise_ai_call")[0]?.body?.p_kind === "cedric");
  check("Cedric's long context is marked cacheable", Array.isArray(cb?.system) && cb.system[0]?.cache_control?.type === "ephemeral" && cb.system[0]?.text === longSystem);
  check("Cedric settles in one call", rpcCalls("settle_credit_hold").length === 1);

  reset(); state.region = "us";
  r = await post(stage()); await r.json();
  check("a US-route account goes to us-east-1 / us. profile", bedrockCalls()[0]?.url === "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-5/invoke", bedrockCalls()[0]?.url);

  reset(); state.bedrock = 403;
  r = await post(stage());
  const e = await r.json();
  check("Bedrock refusal → error passed on, hold released", r.status === 403 && /IAM user's policy/.test(e.error) && rpcCalls("release_credit_hold").length === 1, JSON.stringify(e).slice(0, 160));

  reset(); state.stop = "max_tokens";
  r = await post(stage({ final: true })); const t = await r.json();
  check("truncated answer → 502, released, nothing charged", r.status === 502 && t._charged === false && rpcCalls("release_credit_hold").length === 1 && rpcCalls("settle_credit_hold").length === 0);

  reset();
  r = await fetch(`http://localhost:${PORT}/`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", authorization: "Bearer x" }, body: "{}" });
  check("wrong origin → 403", r.status === 403); await r.body?.cancel();

  reset();
  r = await post({ kind: "cedric", messages: [{ role: "user", content: "x".repeat(1_600_000) }] });
  check("oversized request refused before any spend (413)", r.status === 413 && rpcCalls("authorise_ai_call").length === 0); await r.body?.cancel();
}

if (SCEN === "global") {
  console.log("proxy · a 'global' model id is refused");
  const r = await post(stage()); const d = await r.json();
  check("global route refused with 500 and released", r.status === 500 && /only the eu\. and us\./.test(d.error) && bedrockCalls().length === 0 && rpcCalls("release_credit_hold").length === 1, d.error);
}

if (SCEN === "nocreds") {
  console.log("proxy · AWS keys missing");
  const r = await post(stage()); const d = await r.json();
  check("missing AWS keys → clear 500, nothing sent anywhere", r.status === 500 && /AWS_ACCESS_KEY_ID/.test(d.error) && bedrockCalls().length === 0, d.error);
}

summary("proxy/" + SCEN);
