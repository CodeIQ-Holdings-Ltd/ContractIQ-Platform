#!/usr/bin/env node
/**
 * verify_consistency.mjs — does the website say what the database charges?
 *
 * WHY THIS EXISTS
 *
 * The site shipped with Scale at £199 on pricing.html and checkout.html
 * while the database, the homepage, the features page and the Legal
 * Centre all said £270. A customer could read two different prices for
 * the same plan depending on which page they landed on. Separately, the
 * Legal Centre's credit schedule stated Sandbox 50 and Scale 2,000 when
 * the plan catalogue holds 150 and 1,800 — wrong figures in a document
 * that forms part of the contract.
 *
 * Neither fault was caught, because the existing harness checked that
 * things EXISTED rather than that they AGREED. This file checks agreement.
 *
 * The expected values below are transcribed from MIGRATION_004 and
 * MIGRATION_005 and asserted against them by supabase/TEST_billing.sql,
 * so the two halves cannot drift apart silently.
 *
 * Run:  node verify_consistency.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const PLANS = [
  { key: "sandbox",    price: null, pounds: null, credits: 100,  cap: 0,    days: 90 },
  { key: "growth",     price: 7900, pounds: 79,   credits: 500,  cap: 500,  days: 30 },
  { key: "scale",      price: 27000, pounds: 270, credits: 1800, cap: 1800, days: 30 },
  { key: "enterprise", price: 70000, pounds: 700, credits: 5000, cap: 5000, days: 30 },
];
const BOLTON = { credits: 100, pounds: 25 };
const COST = { analysis: 10, cedric: 2, rerun: 0 };

const PAGES = [
  "index.html", "pricing.html", "features.html", "security.html",
  "legal.html", "checkout.html", "about.html", "contact.html", "success.html",
];

let pass = 0;
const fails = [];
const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };
const bad = (m) => { fails.push(m); console.log(`  FAIL  ${m}`); };

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);

// ── 1 · The catalogue in the SQL is what we think it is ───────────────
const m004 = read("supabase/MIGRATION_004_credits_and_billing.sql") || "";
const m005 = read("supabase/MIGRATION_005_rollover_and_naming.sql") || "";
const m006 = read("supabase/MIGRATION_006_revision_window.sql") || "";
const m007 = read("supabase/MIGRATION_007_bedrock_and_data_safety.sql") || "";
// A later migration can change an allowance; the effective figure is the last one.
const laterCredits = (key) => {
  const m = new RegExp(`update plan_catalogue set credits_included = (\\d+)[^;]*plan = '${key}'`).exec(m007);
  return m ? Number(m[1]) : null;
};

for (const p of PLANS) {
  const row = new RegExp(`'${p.key}',[^\\n]*?(\\d+),\\s*(\\d+),\\s*(\\d+)`, "m").exec(m004);
  if (!row) { bad(`plan_catalogue has no insert row for ${p.key}`); continue; }
  const [, credits004, days, price] = row.map(Number);
  const credits = laterCredits(p.key) ?? credits004;
  if (credits === p.credits && days === p.days && price === (p.price ?? 0)) {
    ok(`plan_catalogue ${p.key}: ${credits} credits / ${days} days / ${price}p`);
  } else {
    bad(`plan_catalogue ${p.key}: SQL says ${credits}/${days}/${price}p, expected ${p.credits}/${p.days}/${p.price ?? 0}p`);
  }
  if (new RegExp(`bank_cap = ${p.cap}[^\\n]*plan = '${p.key}'`).test(m005)) {
    ok(`bank cap for ${p.key} is ${p.cap}`);
  } else {
    bad(`bank cap for ${p.key} is not ${p.cap} in MIGRATION_005`);
  }
}

if (/'credits100',\s*'100 credits',\s*100,\s*2500/.test(m004)) {
  ok(`bolt-on pack is ${BOLTON.credits} credits for £${BOLTON.pounds}`);
} else {
  bad("bolt-on pack is not 100 credits for £25 in MIGRATION_004");
}

// The revision window must be honoured in SQL, not just promised in HTML.
if (/reanalysis_is_free/.test(m006) && /revision_days/.test(m006)) {
  ok("re-runs inside the revision window are free in the database, not just on the pricing page");
} else {
  bad("MIGRATION_006 does not implement the revision window — pricing.html promises free re-runs");
}

// ── 2 · No page contradicts the catalogue on price ───────────────────
const RETIRED = [
  { pattern: /£199/g, why: "Scale's retired pre-September price" },
  { pattern: /£499/g, why: "Enterprise's retired 'from £499'" },
  { pattern: /2,000 credits/g, why: "the wrong Scale allowance (it is 1,800)" },
  { pattern: /\b50 credits\b/g, why: "the wrong Sandbox allowance (it is 100)" },
  { pattern: /\b150 credits\b/g, why: "the old Sandbox allowance (it is 100 since MIGRATION_007)" },
];
for (const page of PAGES) {
  const html = read(page);
  if (html === null) { bad(`${page} is missing`); continue; }
  let clean = true;
  for (const { pattern, why } of RETIRED) {
    const hits = html.match(pattern);
    if (hits) { bad(`${page} still shows ${why} (${hits.length}×)`); clean = false; }
  }
  if (clean) ok(`${page} carries no retired price or allowance`);
}

// ── 3 · Every page that names Scale's price names the same one ───────
const scalePrices = new Set();
for (const page of PAGES) {
  const html = read(page) || "";
  for (const m of html.matchAll(/£(\d{2,4})\s*(?:<small>)?\s*\/?\s*(?:mo|month)/gi)) {
    const n = Number(m[1]);
    if (n === 270 || n === 199) scalePrices.add(n);
  }
}
if (scalePrices.size <= 1 && !scalePrices.has(199)) {
  ok("every page that prices Scale agrees on £270");
} else {
  bad(`pages disagree about Scale's price: ${[...scalePrices].join(", ")}`);
}

// ── 4 · The compiled app is not stale relative to its source ─────────
const jsx = read("contractiq.jsx") || "";
const app = read("app/index.html") || "";
for (const marker of ["supabasePush", "supabaseDelete", "hydrated"]) {
  if (jsx.includes(marker) && app.includes(marker)) {
    ok(`app/index.html is current for "${marker}"`);
  } else if (jsx.includes(marker)) {
    bad(`app/index.html is STALE — "${marker}" is in the source but not the build. Run build.py.`);
  }
}

// ── 5 · The app actually writes something ────────────────────────────
// This is the fault the September audit found and nobody had closed:
// zero insert/upsert/update/delete anywhere in the shipped bundle.
const writes = (app.match(/\.(insert|upsert|update|delete)\(/g) || []).length;
if (writes > 0) {
  ok(`the shipped bundle performs ${writes} write operation(s) — work persists`);
} else {
  bad("the shipped bundle performs NO writes — nothing a customer does will survive a refresh");
}
for (const t of ['from("contracts").upsert', 'from("documents").upsert', 'from("contracts").delete']) {
  app.includes(t) ? ok(`bundle contains ${t}`) : bad(`bundle is missing ${t}`);
}

// ── 6 · Credit costs quoted on the site match the SQL ────────────────
const pricing = read("pricing.html") || "";
const sqlCost = /when p_kind = 'analysis'\s+then (\d+)/.exec(m006);
if (sqlCost && Number(sqlCost[1]) === COST.analysis) {
  ok(`an analysis costs ${COST.analysis} credits in SQL`);
} else {
  bad("the analysis cost in MIGRATION_006 is not 10 credits");
}
if (new RegExp(`${COST.analysis} credits`).test(pricing) && new RegExp(`${COST.cedric} credits`).test(pricing)) {
  ok("pricing.html quotes 10 credits an analysis and 2 a question, matching the SQL");
} else {
  bad("pricing.html no longer quotes the credit costs the SQL charges");
}

// ── 7 · The Legal Centre's schedule matches the catalogue ────────────
// Read the schedule as text and look for "<edition name> <allowance>" side by
// side. (This used to test only that the number appeared ANYWHERE on the
// page, so a Sandbox of 150 passed because "100" appears in the bolt-on
// sentence. A check that cannot fail is not a check.)
const legal = read("legal.html") || "";
const legalText = legal.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
const EDITION_NAMES = { sandbox: "Evaluation Sandbox", growth: "Growth / Professional", scale: "Scale", enterprise: "Enterprise Suite" };
for (const p of PLANS) {
  const shown = p.credits.toLocaleString("en-GB");
  new RegExp(`${EDITION_NAMES[p.key].replace(/[/]/g, "\\/")} ${shown.replace(",", ",")}\\b`).test(legalText)
    ? ok(`legal.html schedule gives ${p.key} an allowance of ${shown}`)
    : bad(`legal.html schedule does not give ${p.key} an allowance of ${shown}`);
}

// ── 8 · The entity on every page is the right one ────────────────────
// terms/privacy/dpa once named Rita Baxi Limited, which has no role here.
for (const page of PAGES) {
  const html = read(page) || "";
  if (/Rita Baxi Limited|10885786/.test(html)) {
    bad(`${page} names Rita Baxi Limited, which has no role in ContractIQ`);
  }
}
ok("no page names the wrong contracting entity");

// ── 9 · What we say about data matches what the code does (v13) ──────
// Each of these was published at some point while the code did something
// different. They are checked here so they cannot drift back.
const FALSE_CLAIMS = [
  { pattern: /never written to the database/i, why: "document text IS stored (documents.extracted_text) unless Zero-Retention is on" },
  { pattern: /Anthropic'?s API/i, why: "the AI now runs on Amazon Bedrock; Anthropic receives nothing" },
  { pattern: /volatile memory/i, why: "no such pipeline exists; Zero-Retention keeps text in the browser tab" },
  { pattern: /TLS 1\.3/i, why: "we do not control the TLS version end to end" },
  { pattern: /contractually prohibited from training/i, why: "stated precisely now: the AI Provider does not store or train" },
];
const APP_PAGES = [...PAGES, "contractiq.jsx"];
for (const page of APP_PAGES) {
  // In the source, only what a user can read counts — not code comments.
  const raw = read(page) || "";
  const text = page.endsWith(".jsx") ? raw.replace(/^\s*\/\/.*$/gm, "") : raw;
  let clean = true;
  for (const { pattern, why } of FALSE_CLAIMS) {
    if (pattern.test(text)) { bad(`${page} says something the code does not do: ${pattern} — ${why}`); clean = false; }
  }
  if (clean) ok(`${page} makes no data claim the code contradicts`);
}
/Amazon Web Services EMEA SARL/.test(legal) && /Amazon Bedrock/.test(legal)
  ? ok("the sub-processor list names Amazon Web Services (Amazon Bedrock) as the AI Provider")
  : bad("the sub-processor list does not name the AI Provider the code actually uses");
const proxy = read("supabase/functions/anthropic-proxy/index.ts") || "";
const worker = read("supabase/functions/job-worker/index.ts") || "";
(/routeProblem/.test(proxy) && /routeProblem/.test(worker) && /eu\.anthropic\.claude-sonnet-5/.test(proxy))
  ? ok("both AI functions default to the EU route and refuse the global one")
  : bad("an AI function no longer defaults to the EU route or no longer refuses the global one");
!/api\.anthropic\.com/.test(proxy.replace(/if \(PROVIDER === "anthropic"\)[\s\S]*?\n  \}/, ""))
  ? ok("the proxy calls Anthropic directly only on the explicit emergency switch")
  : bad("the proxy calls api.anthropic.com outside the emergency switch");
/forceFunctionRegion=eu-west-2/.test(app)
  ? ok("the shipped app pins the AI function to London")
  : bad("the shipped app does not pin the AI function to London");

console.log(`\n  ${pass} passed, ${fails.length} failed.`);
if (fails.length) process.exit(1);
