/* Drives the BUILT live app (app/index.html, DEMO_MODE=false) in a real
   browser against a stand-in Supabase, and checks what v13 changed:
     · the background queue receives ALL FIVE stages, with the documents
       once as a shared block (it used to receive stage one only);
     · a finished background job is applied to the record the same way the
       in-browser path applies it;
     · Zero-Retention forces the in-browser path, pins the AI function to
       London, marks the documents block cacheable, and never saves text.
   Run: node test_live_paths.mjs */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8124;
const NM = path.join(ROOT, "..", "node_modules");
const LOCAL = {
  "/vendor/react.js": path.join(NM, "react/umd/react.production.min.js"),
  "/vendor/react-dom.js": path.join(NM, "react-dom/umd/react-dom.production.min.js"),
};

// A stand-in for supabase-js: every query builder chain resolves through
// handlers configured per test, and every call is recorded.
const supabaseStub = `
(function () {
  const S = window.__sb;
  function builder(table) {
    const q = { table, ops: [] };
    const run = () => {
      const h = S.tables[table];
      const r = h ? h(q) : { data: [], error: null };
      S.calls.push({ table, ops: JSON.parse(JSON.stringify(q.ops)) });
      return Promise.resolve(r);
    };
    const p = new Proxy(function () {}, {
      get(_, prop) {
        if (prop === "then") return (res, rej) => run().then(res, rej);
        return (...args) => { q.ops.push([prop, args]); return p; };
      },
    });
    return p;
  }
  window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: S.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
    },
    from: (t) => builder(t),
    rpc: async (name, args) => {
      S.calls.push({ rpc: name, args: JSON.parse(JSON.stringify(args || {})) });
      const h = S.rpc[name];
      return h ? h(args) : { data: null, error: null };
    },
  }) };
})();`;

const initScript = (plan, zr) => `
window.__sb = {
  calls: [], jobsRows: [], completed: null,
  session: { access_token: "tok", user: { id: "u1", email: "alice@alpha.test", email_confirmed_at: "2026-09-01", user_metadata: { full_name: "Alice" }, app_metadata: { provider: "email" } } },
  tables: {
    account_members: () => ({ data: { account_id: "acct-1" }, error: null }),
    profiles: () => ({ data: { terms_accepted_at: "2026-09-01", terms_version: "2026.2" }, error: null }),
    contracts: (q) => {
      const sel = q.ops.find((o) => o[0] === "select");
      if (sel && String(sel[1][0]).includes("analysis") && q.ops.some((o) => o[0] === "eq"))
        return { data: window.__sb.completed ? { id: "x", analysis: window.__sb.completed } : null, error: null };
      return { data: [], error: null };
    },
    documents: () => ({ data: [], error: null }),
    my_jobs: (q) => {
      const sel = q.ops.find((o) => o[0] === "select");
      if (sel && String(sel[1][0]).includes("result")) return { data: null, error: null };
      return { data: window.__sb.jobsRows, error: null };
    },
  },
  rpc: {
    my_entitlement: () => ({ data: Object.assign({ ok: true, account_id: "acct-1", plan: "${plan}", plan_name: "${plan}", period_days: 30,
      credits: { included: 5000, plan_left: 5000, bolton_left: 0, held: 0, total_left: 5000, used: 0 } }, window.__entExtra || {}), error: null }),
    my_workspace_settings: () => ({ data: { ok: true, zero_retention: ${zr}, data_region: "eu" }, error: null }),
    enqueue_job: (a) => { window.__sb.jobsRows = [{ id: "job-1", contract_id: a.p_contract_id, status: "running", kind: a.p_kind, ref: "REF" }];
                          return { data: { id: "job-1", status: "queued" }, error: null }; },
    set_zero_retention: (a) => ({ data: a.p_on, error: null }),
  },
};`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (LOCAL[p]) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(LOCAL[p])); }
  if (p.startsWith("/stub/")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(p === "/stub/supabase.js" ? supabaseStub : "/* stubbed */");
  }
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("nf"); }
  let body = fs.readFileSync(fp).toString();
  if (fp.endsWith(".html")) {
    body = body
      .replace(/<link[^>]+fonts\.googleapis[^>]+>/g, "")
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/[^"']+react\.production\.min\.js/g, "/vendor/react.js")
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/[^"']+react-dom\.production\.min\.js/g, "/vendor/react-dom.js")
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/(pdf\.js|xlsx|mammoth|tesseract\.js)\/[^"']+/g, "/stub/lib.js")
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^"']+/g, "/stub/supabase.js")
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^"']+/g, "/stub/lib.js");
  }
  res.writeHead(200, { "content-type": fp.endsWith(".html") ? "text/html" : "text/plain" }); res.end(body);
});

let pass = 0, fail = 0;
const out = [];
const check = (n, ok, d = "") => { ok ? pass++ : fail++; out.push(`  ${ok ? "✓" : "✗"} ${n}${!ok && d ? "\n      " + d : ""}`); };

await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});

async function openApp(plan, zr, extra = "") {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(initScript(plan, zr));
  if (extra) await ctx.addInitScript(`window.__entExtra = ${extra};`);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const proxyCalls = [];
  await page.route("**/functions/v1/anthropic-proxy**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204 });
    const body = JSON.parse(req.postData() || "{}");
    proxyCalls.push({ url: req.url(), body });
    const task = body.messages?.[0]?.content?.[1]?.text || "";
    const n = /Extract the facts/.test(task) ? 1 : /commercial position/.test(task) ? 2 : /risks and savings/.test(task) ? 3 : /compliance and obligations/.test(task) ? 4 : 5;
    const payload = { 1: { extracted: { name: "Stage one name" }, execSummary: "SUMMARY-FROM-STAGE-1", dataPoints: [] },
                      2: { cost: { summary: "COST-FROM-STAGE-2", breakdown: [], estimatedAnnualSaving: 1000 } },
                      3: { risks: [], opportunities: [] }, 4: { compliance: { summary: "c", clauses: [], regulatory: [] }, obligations: [] },
                      5: { insights: { summary: "INSIGHTS-FROM-STAGE-5", negotiationLevers: [], recommendations: [], watchDates: [] }, knowledge: { summary: "", points: [] } } }[n];
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn", usage: {} }) });
  });
  await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { ctx, page, errors, proxyCalls };
}

async function openSampleContract(page) {
  const load = page.locator('button:has-text("Load a sample portfolio")').first();
  if (await load.count()) { await load.click(); await page.waitForTimeout(500); }
  const row = page.locator(".prow, .contract-row, tr, .card").filter({ hasText: /Microsoft|CTR-/i }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(500); }
  return page.locator('button:has-text("Run AI analysis"), button:has-text("Re-run AI analysis")').first();
}

try {
  console.log("\nContractIQ live paths (v13)\n");

  // ── A · Background queue ─────────────────────────────────────────
  {
    const { ctx, page, errors, proxyCalls } = await openApp("growth", false);
    const btn = await openSampleContract(page);
    check("signed-in app shows the analyse button", await btn.isVisible().catch(() => false));
    await btn.click();
    await page.waitForTimeout(1200);
    const enq = await page.evaluate(() => window.__sb.calls.find((c) => c.rpc === "enqueue_job"));
    const pl = enq?.args?.p_payload;
    check("the queue is used on Growth (no direct AI calls)", !!enq && proxyCalls.length === 0, `enqueue=${!!enq} proxy=${proxyCalls.length}`);
    check("the queued job carries all five stages", pl?.v === 2 && Array.isArray(pl?.stages) && pl.stages.length === 5
      && pl.stages.every((s) => /^YOUR TASK FOR THIS STEP/.test(s.task) && s.max_tokens === 8000), JSON.stringify(pl?.stages?.map((s) => s.n)));
    check("the documents travel once, as the shared context", typeof pl?.context === "string" && pl.context.includes("INGESTED DOCUMENTS")
      && pl.stages.every((s) => !s.task.includes("INGESTED DOCUMENTS")));
    check("no old single-prompt payload", !("prompt" in (pl || {})));

    // Let the poller see the job running (it polls every four seconds; a
    // real analysis takes a minute or more), then finish it on the "server".
    await page.waitForTimeout(4500);
    await page.evaluate(() => {
      window.__sb.jobsRows = [];
      window.__sb.completed = { extracted: { name: "From the queue" }, execSummary: "QUEUED-SUMMARY",
        cost: { summary: "QUEUED-COST-SECTION", breakdown: [], estimatedAnnualSaving: 5 },
        insights: { summary: "QUEUED-INSIGHTS", negotiationLevers: [], recommendations: [], watchDates: [] }, dataPoints: [] };
    });
    await page.waitForTimeout(5500);
    const costTab = page.locator('.tab:has-text("Cost"), button:has-text("Cost")').first();
    if (await costTab.count()) { await costTab.click().catch(() => {}); await page.waitForTimeout(400); }
    check("a finished background job fills the record (cost section visible)",
      await page.locator("text=QUEUED-COST-SECTION").first().isVisible().catch(() => false));
    check("no page errors on the queue path", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ── B · Zero-Retention (Enterprise) ──────────────────────────────
  {
    const { ctx, page, errors, proxyCalls } = await openApp("enterprise", true);
    const btn = await openSampleContract(page);
    await btn.click();
    for (let i = 0; i < 40 && proxyCalls.length < 5; i++) await page.waitForTimeout(250);
    await page.waitForTimeout(1500);
    const enq = await page.evaluate(() => window.__sb.calls.find((c) => c.rpc === "enqueue_job"));
    check("Zero-Retention runs in the tab: nothing queued", !enq && proxyCalls.length === 5, `enqueue=${!!enq} proxy=${proxyCalls.length}`);
    check("every AI call is pinned to the London function", proxyCalls.every((c) => c.url.includes("forceFunctionRegion=eu-west-2")));
    check("documents block first and cacheable, task second", proxyCalls.every((c) => {
      const ct = c.body.messages?.[0]?.content;
      return Array.isArray(ct) && ct[0].cache_control?.type === "ephemeral" && ct[0].text.includes("INGESTED DOCUMENTS") && /^YOUR TASK/.test(ct[1].text);
    }));
    check("one run id across the five stages, last one final",
      new Set(proxyCalls.map((c) => c.body.run_id)).size === 1 && proxyCalls.filter((c) => c.body.final === true).length === 1 && proxyCalls[4]?.body.final === true);
    const titled = await page.locator("text=Stage one name").first().isVisible().catch(() => false);
    const cTab = page.locator('.tab:has-text("Cost"), button:has-text("Cost")').first();
    if (await cTab.count()) { await cTab.click().catch(() => {}); await page.waitForTimeout(300); }
    check("stages merged: stage 1 named the record, stage 2 filled Cost", titled
      && await page.locator("text=COST-FROM-STAGE-2").first().isVisible().catch(() => false));
    await page.waitForTimeout(2500);   // let autosave run
    const docUpserts = await page.evaluate(() => window.__sb.calls.filter((c) => c.table === "documents" && c.ops.some((o) => o[0] === "upsert")));
    const texts = docUpserts.flatMap((c) => c.ops.filter((o) => o[0] === "upsert").flatMap((o) => o[1][0] || [])).map((d) => d.extracted_text);
    check("with Zero-Retention on, no document text is ever sent to the database",
      texts.length > 0 && texts.every((t) => t === null), `upserts=${texts.length} nonNull=${texts.filter((t) => t !== null).length}`);
    check("no page errors on the Zero-Retention path", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ── D · "Start free" lands on the sign-up form, not the sign-in box ─
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/app/index.html?signup=1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    check("app/?signup=1 opens the create-account form",
      await page.locator('button:has-text("Create account")').first().isVisible().catch(() => false));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    check("without it, the app still opens on sign in",
      (await page.locator('button:has-text("Create account")').count()) === 0);
    await ctx.close();
  }

  // ── C · The Sandbox is a one-off: ended, ending soon, and fine ───
  {
    const sbx = (ended, daysLeft, left) => JSON.stringify({ plan: "sandbox", plan_name: "Evaluation Sandbox", period_days: 10,
      sandbox: { ended, one_off: true, ends_at: new Date(Date.now() + daysLeft * 864e5).toISOString() },
      credits: { included: ended ? 0 : 100, plan_left: left, bolton_left: 0, held: 0, total_left: left, used: ended ? 0 : 100 - left } });
    {
      const { ctx, page, errors } = await openApp("sandbox", false, sbx(true, -3, 0));
      const t = await page.locator('[role="status"]').first().textContent().catch(() => "");
      check("an ended Sandbox shows the upgrade banner (10 days up)", /Evaluation Sandbox has ended/.test(t) && /10 days are up/.test(t) && /view and export/.test(t), t.slice(0, 160));
      await page.locator('[role="status"] button:has-text("Choose a plan")').click().catch(() => {});
      await page.waitForTimeout(400);
      check("Choose a plan opens the in-app pricing page", await page.locator("text=Simple tiers").first().isVisible().catch(() => false));
      check("no page errors with an ended Sandbox", errors.length === 0, errors.slice(0, 2).join(" | "));
      await ctx.close();
    }
    {
      const { ctx, page } = await openApp("sandbox", false, sbx(false, 7, 0));
      const t = await page.locator('[role="status"]').first().textContent().catch(() => "");
      check("a Sandbox with every credit used shows the banner before day 90", /has ended/.test(t) && /all 100 credits are used/.test(t), t.slice(0, 160));
      await ctx.close();
    }
    {
      const { ctx, page } = await openApp("sandbox", false, sbx(false, 3, 60));
      const t = await page.locator('[role="status"]').first().textContent().catch(() => "");
      check("a Sandbox ending in 3 days says so", /ends in 3 days/.test(t) && /60 left/.test(t), t.slice(0, 160));
      await ctx.close();
    }
    {
      const { ctx, page } = await openApp("sandbox", false, sbx(false, 7, 90));
      check("a healthy Sandbox shows no banner", (await page.locator('[role="status"]').count()) === 0);
      await ctx.close();
    }
    {
      const { ctx, page } = await openApp("growth", false);
      check("a paid plan shows no Sandbox banner", (await page.locator('[role="status"]').count()) === 0);
      await ctx.close();
    }
  }
} catch (e) {
  check("the flow ran to completion", false, e.message);
} finally {
  console.log(out.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
}
