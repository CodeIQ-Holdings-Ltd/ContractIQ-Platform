import { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────
// ContractIQ v4 — Intelligent contract analysis
// Contract Records · AI extraction · Ask Cedric · Playbook engine
// Public product pages · Zero-Retention mode · Light-blue Apple design
// DEMO_MODE=true disables all AI calls and serves sample output (no API cost)
//
// REVIEWER NOTES (architecture & security):
// · Auth: demo-grade SHA-256 credential hashing (no plaintext in source or
//   state). Production = Supabase Auth; see /supabase schema for tenant RLS.
// · Tenant isolation: enforced server-side by Postgres Row Level Security;
//   Cedric context is built only from the session's RLS-filtered data.
// · XSS: all AI/user strings are esc()-escaped before HTML export contexts.
// · Secrets: none in this file. The Anthropic key lives server-side in a
//   Supabase Edge Function in production.
// · Erasure: Admins can hard-delete a record + documents + analysis (UI),
//   satisfying data-subject deletion at the workspace level.
// · CSV import uses a simple comma parser: quoted commas inside fields are
//   not supported — documented product limitation, not a defect.
// ─────────────────────────────────────────────────────────────

const DEMO_MODE = false;

// ── DEPLOYMENT CONFIG ─────────────────────────────────────────
// Set these ONCE, before you publish. Every visitor then gets a working
// app without touching Settings.
//
// Both values are safe to ship in a public page. The publishable key is
// designed to be public — it is what a browser is meant to hold, and it
// is constrained by the row-level security policies in your database.
// The SECRET key is the one that must never appear here.
//
// Leave them empty and the app falls back to asking each user for them
// in Settings, which is only sensible for local testing.
const SUPABASE_URL = "https://aremuhzsgmqginhmpfno.supabase.co";              // e.g. https://aremuhzsgmqginhmpfno.supabase.co
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5XMn3xiA5ueSGDfjvOxgew_0Cp0TWwr";  // e.g. sb_publishable_...


// ── AI ENDPOINT ───────────────────────────────────────────────
// The browser must NEVER hold the Anthropic key: it would be readable by
// anyone who opens dev tools, and Anthropic blocks direct browser calls
// anyway. All AI traffic goes through a server-side proxy that holds the
// key. Set your Supabase project URL in Settings and this resolves to
// that project's `anthropic-proxy` Edge Function automatically.
let AI_ENDPOINT = "";
// Two different credentials, and the difference matters. The publishable
// key identifies the PROJECT — Supabase's gateway will not route a request
// without it. The access token identifies the PERSON, and is what the
// proxy now checks before it spends a penny of Anthropic credit. Sending
// only the publishable key, as this used to, meant anyone holding a key
// that is published on purpose could run analyses on your account.
let AI_APIKEY = "";
let AI_TOKEN  = "";
let CHECKOUT_ENDPOINT = "";
// ── SUPABASE AUTH ─────────────────────────────────────────────
// Real accounts, replacing the built-in demo logins. Sign-up sends a
// verification email; nothing is usable until the address is confirmed.
// The client is created lazily because the project URL and key come
// from Settings rather than being baked into the build.
let sbClient = null;
let sbConfig = { url: "", key: "" };

async function loadSupabaseLib() {
  if (window.supabase?.createClient) return window.supabase;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
    s.onload = res;
    s.onerror = () => rej(new Error("Could not load the authentication library"));
    document.head.appendChild(s);
  });
  return window.supabase;
}

async function getSb(url, key) {
  if (!url || !key) return null;
  if (sbClient && sbConfig.url === url && sbConfig.key === key) return sbClient;
  const lib = await loadSupabaseLib();
  sbClient = lib.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  sbConfig = { url, key };
  return sbClient;
}

// Where verification and OAuth links come back to. Supabase requires
// this exact URL on the allow-list under Authentication → URL
// Configuration, or the link silently bounces to the site root.
const authRedirectUrl = () => window.location.origin + window.location.pathname;

// Supabase returns terse messages. Translate them into something a
// person can actually act on.
function friendlyAuthError(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid login credentials"))
    return "That email and password combination was not recognised. Check for typos, or reset your password below.";
  if (m.includes("email not confirmed"))
    return "Your email address has not been verified yet. Check your inbox for the link we sent.";
  if (m.includes("already registered"))
    return "An account already exists for that address. Try signing in, or reset your password.";
  if (m.includes("password should be at least"))
    return "Your password needs to be at least 8 characters.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts. Wait a minute and try again.";
  if (m.includes("redirect") || m.includes("not allowed"))
    return "This address is not on the allow-list in Supabase. Add it under Authentication → URL Configuration.";
  return msg || "Something went wrong. Please try again.";
}

// Guidance, never a hard gate beyond the minimum. Fighting someone over
// a passphrase they will remember is worse security than a short one
// they write on a sticky note.
function passwordStrength(pw) {
  if (!pw) return { score: 0, label: "", colour: "#C7D3E3" };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const map = [
    { label: "Too short", colour: "#E0493E" },
    { label: "Weak", colour: "#E0493E" },
    { label: "Fair", colour: "#EE9420" },
    { label: "Good", colour: "#2F7BD9" },
    { label: "Strong", colour: "#2E9E6B" },
    { label: "Very strong", colour: "#2E9E6B" },
  ];
  return { score: s, ...map[Math.min(s, 5)] };
}

// Deep links into common webmail clients — removes a real moment of
// friction on the verify screen.
function mailProviderLink(email) {
  const domain = (String(email).split("@")[1] || "").toLowerCase();
  if (/gmail|googlemail/.test(domain))
    return { name: "Open Gmail", url: "https://mail.google.com/mail/u/0/" };
  if (/outlook|hotmail|live|msn/.test(domain))
    return { name: "Open Outlook", url: "https://outlook.live.com/mail/0/inbox" };
  if (/yahoo/.test(domain)) return { name: "Open Yahoo Mail", url: "https://mail.yahoo.com/" };
  if (/icloud|me\.com|mac\.com/.test(domain)) return { name: "Open iCloud Mail", url: "https://www.icloud.com/mail" };
  if (/proton/.test(domain)) return { name: "Open Proton Mail", url: "https://mail.proton.me/" };
  return null;   // corporate domain — no sensible deep link
}

const configureAI = (supabaseUrl, anonKey) => {
  const base = supabaseUrl ? supabaseUrl.replace(/\/$/, "") : "";
  AI_ENDPOINT       = base ? `${base}/functions/v1/anthropic-proxy` : "";
  CHECKOUT_ENDPOINT = base ? `${base}/functions/v1/create-checkout-session` : "";
  AI_APIKEY = anonKey || "";
};
// Called whenever the signed-in session changes, so the token travelling
// with an analysis is always the current one.
const setAiToken = (token) => { AI_TOKEN = token || ""; };
const aiHeaders = () => ({
  "Content-Type": "application/json",
  ...(AI_APIKEY ? { apikey: AI_APIKEY } : {}),
  // The user's token when signed in; the publishable key otherwise, so an
  // unauthenticated attempt comes back as a clean, explained 401 rather
  // than a CORS failure the user cannot interpret.
  ...(AI_TOKEN || AI_APIKEY ? { Authorization: `Bearer ${AI_TOKEN || AI_APIKEY}` } : {}),
});
const aiUnavailable = () =>
  new Error("No AI endpoint configured. Add your Supabase project URL and publishable key in Settings, and deploy the anthropic-proxy Edge Function.");

// ─────────────────────────────────────────────────────────────
// EDITIONS — one codebase, four plans.
//
// WHICH PLAN IS IN FORCE COMES FROM THE DATABASE, NOT FROM THIS FILE.
// It used to be a compiled constant, which is why every founding member
// received the full Enterprise feature set no matter what their account
// row said: the database was setting plan='growth' and the bundle was
// ignoring it. my_entitlement() is now read at sign-in and EDITION is
// replaced with whatever it returns.
//
// The value below is only what an unauthenticated or offline session
// falls back to — deliberately the LEAST generous plan, so a failure to
// read entitlement can never hand someone a plan they have not bought.
//
// PRODUCTION NOTE: these gates are the user-facing experience. The binding
// enforcement lives server-side — credits are reserved and settled by the
// database, and the AI proxy refuses a call the account cannot afford.
// A client-side gate is a courtesy, never a security control.
// ─────────────────────────────────────────────────────────────
const FALLBACK_EDITION = "sandbox";
let EDITION = FALLBACK_EDITION;

// ── CREDITS ──────────────────────────────────────────────────
// One credit ≈ £0.006 of underlying AI cost (measured, with ~20%
// headroom). Pricing every AI action in the same unit means a heavy
// Cedric user can no longer quietly cost more than they pay — which
// was the real exposure while Cedric was unmetered.
// ── PORTFOLIO SEARCH ─────────────────────────────────────────
// Repository-wide search is one of the highest-value capabilities in this
// category and the thing buyers test first: "we can't find anything".
// Searches record fields, ingested document text, and every analysis
// finding — risks, clauses, obligations, knowledge — returning the
// surrounding snippet so the answer is visible without opening anything.
const SEARCH_FIELDS = [
  { key: "ref", label: "Reference" }, { key: "supplier", label: "Supplier" },
  { key: "name", label: "Name" }, { key: "category", label: "Category" },
  { key: "owner", label: "Owner" }, { key: "notes", label: "Notes" },
];
function snippet(text, q, pad = 90) {
  if (!text) return "";
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const s = Math.max(0, i - pad), e = Math.min(text.length, i + q.length + pad);
  return (s > 0 ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ").trim() + (e < text.length ? "…" : "");
}
function searchPortfolio(contracts, query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const ql = q.toLowerCase();
  const out = [];
  for (const c of contracts) {
    const hits = [];
    for (const f of SEARCH_FIELDS) {
      const v = c[f.key];
      if (v && String(v).toLowerCase().includes(ql)) hits.push({ where: f.label, text: snippet(String(v), q) || String(v) });
    }
    for (const d of c.documents || []) {
      if (d.name?.toLowerCase().includes(ql)) hits.push({ where: "Document name", text: d.name });
      const s = snippet(d.text, q);
      if (s) hits.push({ where: `In ${d.name}`, text: s });
    }
    const a = c.analysis;
    if (a) {
      for (const r of a.risks || []) {
        const s = snippet(`${r.title}. ${r.detail}`, q);
        if (s) hits.push({ where: `Risk · ${r.severity}`, text: s });
      }
      for (const o of a.opportunities || []) {
        const s = snippet(`${o.title}. ${o.detail}`, q);
        if (s) hits.push({ where: `Opportunity · ${o.savingEstimate}`, text: s });
      }
      for (const cl of a.compliance?.clauses || []) {
        const s = snippet(`${cl.clause}. ${cl.note}`, q);
        if (s) hits.push({ where: `Clause · ${cl.status}`, text: s });
      }
      for (const ob of a.obligations || []) {
        const s = snippet(`${ob.obligation}. ${ob.note}`, q);
        if (s) hits.push({ where: `Obligation · ${ob.owner}`, text: s });
      }
      for (const k of a.knowledge?.points || []) {
        const s = snippet(`${k.insight}. ${k.matters}`, q);
        if (s) hits.push({ where: `Knowledge · ${k.source}`, text: s });
      }
      for (const v of a.knowledge?.verbalCommitments || []) {
        const s = snippet(`${v.commitment}. ${v.action}`, q);
        if (s) hits.push({ where: `Verbal commitment · ${v.saidBy}`, text: s });
      }
      const s = snippet(a.execSummary, q);
      if (s) hits.push({ where: "Executive summary", text: s });
    }
    if (hits.length) out.push({ contract: c, hits: hits.slice(0, 6), total: hits.length });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ── SUPPLIER CONSOLIDATION ───────────────────────────────────
// The same supplier bought three times by three teams under three names is
// the most common source of recoverable spend in a mid-sized estate — and
// it is invisible while you look at contracts one at a time. Normalising
// the name and grouping is crude but catches the majority of real cases.
const normaliseSupplier = (s) => (s || "")
  .toLowerCase()
  .replace(/\b(ltd|limited|plc|llp|inc|incorporated|corp|corporation|gmbh|sa|bv|pty|co|company|uk|group|holdings|international|services|solutions|technologies|technology|systems|software)\b/g, "")
  .replace(/[^a-z0-9]/g, "")
  .trim();

// Levenshtein distance, capped — enough to catch "Vertex"/"Vertexx" and
// "Northgate"/"North Gate" without pretending to be entity resolution.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function supplierIntelligence(contracts) {
  const groups = {};
  for (const c of contracts) {
    const k = normaliseSupplier(c.supplier) || "unknown";
    (groups[k] ||= { key: k, names: new Set(), contracts: [], spend: 0, categories: new Set() });
    groups[k].names.add(c.supplier);
    groups[k].contracts.push(c);
    groups[k].spend += Number(c.annualValue) || 0;
    if (c.category) groups[k].categories.add(c.category);
  }
  const list = Object.values(groups).map((g) => {
    const grades = g.contracts.map((c) => c.analysis?.riskGrade).filter(Boolean);
    const order = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 };
    const worst = grades.sort((a, b) => (order[b] || 0) - (order[a] || 0))[0] || null;
    const next = g.contracts
      .map((c) => c.endDate).filter(Boolean).sort()[0] || null;
    return {
      ...g, names: [...g.names], categories: [...g.categories],
      count: g.contracts.length, worstGrade: worst, nextEnd: next,
      savings: g.contracts.reduce((s, c) =>
        s + (c.analysis?.opportunities || []).reduce((t, o) => t + (Number(o.savingValue) || 0), 0), 0),
    };
  }).sort((a, b) => b.spend - a.spend);

  // Near-duplicate supplier names that normalised differently.
  const dupes = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].key, b = list[j].key;
      if (!a || !b || a === "unknown" || b === "unknown") continue;
      const d = editDistance(a, b);
      const isNear = d <= Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.2));
      if (isNear || a.includes(b) || b.includes(a)) {
        dupes.push({ a: list[i], b: list[j], distance: d });
      }
    }
  }
  // Two or more separate suppliers serving the same category = a consolidation question.
  const byCategory = {};
  for (const g of list) {
    for (const cat of g.categories) (byCategory[cat] ||= []).push(g);
  }
  const overlaps = Object.entries(byCategory)
    .filter(([, gs]) => gs.length > 1)
    .map(([category, gs]) => ({
      category, groups: gs,
      spend: gs.reduce((s, g) => s + g.spend, 0),
      count: gs.reduce((s, g) => s + g.count, 0),
    }))
    .sort((a, b) => b.spend - a.spend);

  return { list, dupes, overlaps, multiContract: list.filter((g) => g.count > 1) };
}

// ── THIRD-PARTY RISK ──────────────────────────────────────────
// The gap that matters for a procurement buyer: the contract is only
// half the picture. How critical is this supplier, how exposed are we
// if they fail, and what have they actually committed to?
//
// Everything here is derived from analysis already performed — no new
// AI call, so the page costs nothing to open.
function vendorRisk(contracts) {
  const groups = supplierIntelligence(contracts);
  const totalSpend = contracts.reduce((s, c) => s + (Number(c.annualValue) || 0), 0) || 1;

  const CHECKS = [
    { key: "liability",  label: "Liability cap",        look: /liabilit/i },
    { key: "insurance",  label: "Insurance",            look: /insur/i },
    { key: "dataprot",   label: "Data protection",      look: /data protection|gdpr|dpa|personal data/i },
    { key: "security",   label: "Security commitments", look: /security|iso 27001|soc ?2|encryp/i },
    { key: "continuity", label: "Business continuity",  look: /continuity|disaster|resilien/i },
    { key: "exit",       label: "Exit assistance",      look: /exit|transition|migrat/i },
    { key: "audit",      label: "Audit rights",         look: /audit|inspect/i },
    { key: "subco",      label: "Subcontracting",       look: /subcontract|sub-processor|subprocessor/i },
  ];

  return groups.list.map((g) => {
    // Which protections can we actually evidence from the analysis?
    const clauses = g.contracts.flatMap((c) => c.analysis?.compliance?.clauses || []);
    const findings = CHECKS.map((chk) => {
      const hit = clauses.find((cl) => chk.look.test(cl.clause || ""));
      return { ...chk, status: hit ? hit.status : "unknown", note: hit?.note };
    });
    const present = findings.filter((f) => f.status === "present").length;
    const missing = findings.filter((f) => f.status === "missing").length;

    const spendShare = g.spend / totalSpend;
    const analysed = g.contracts.filter((c) => c.analysis).length;
    const worstGradeScore = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 }[g.worstGrade] ?? null;

    // Criticality is about how much it would hurt if they stopped, not
    // how much we like them. Spend share and contract count both feed it.
    let criticality = "Low";
    if (spendShare >= 0.20 || g.count >= 3) criticality = "High";
    else if (spendShare >= 0.08 || g.count >= 2) criticality = "Medium";

    // A single 0-100 score. Deliberately transparent: every component is
    // shown in the UI, because an opaque risk score is not actionable.
    const components = [
      { label: "Missing protections", weight: Math.min(40, missing * 8),
        detail: `${missing} of ${CHECKS.length} not evidenced` },
      { label: "Spend concentration", weight: Math.round(Math.min(25, spendShare * 100)),
        detail: `${(spendShare * 100).toFixed(1)}% of portfolio spend` },
      { label: "Contract risk grade", weight: worstGradeScore === null ? 10 : worstGradeScore * 5,
        detail: g.worstGrade ? `Worst grade ${g.worstGrade}` : "Not yet analysed" },
      { label: "Unanalysed contracts", weight: (g.count - analysed) * 6,
        detail: `${g.count - analysed} of ${g.count} not analysed` },
    ];
    const score = Math.min(100, components.reduce((s, c) => s + c.weight, 0));
    const band = score >= 55 ? "High" : score >= 30 ? "Medium" : "Low";

    return { ...g, findings, present, missing, criticality, score, band, components,
             spendShare, analysed };
  }).sort((a, b) => b.score - a.score);
}

// ── SUPPLIER TIMELINE ─────────────────────────────────────────
// Everything held about one supplier, on one line, in date order. The
// pattern is what matters: an outage, then a waiver, then an account
// manager change, then an unpaid credit, then another change. No single
// document shows that — only the sequence does.
function supplierTimeline(contracts, supplierKey) {
  const mine = contracts.filter((c) => normaliseSupplier(c.supplier) === supplierKey);
  const ev = [];
  const push = (date, kind, title, detail, ct) => {
    const d = date ? new Date(date) : null;
    if (!d || isNaN(d)) return;
    ev.push({ date: d, kind, title, detail, ref: ct?.ref, contractId: ct?.id });
  };

  for (const c of mine) {
    push(c.startDate, "start", `${c.ref} begins`, `${c.name || c.category || "Agreement"} commences.`, c);
    for (const d of (c.documents || [])) {
      const isTx = /transcript|\.vtt|\.srt/i.test(`${d.type || ""} ${d.name || ""}`);
      push(d.uploadedAt || d.addedAt, isTx ? "transcript" : "doc",
           isTx ? `Meeting recorded — ${d.name}` : `Document added — ${d.name}`,
           isTx ? "Transcript ingested against this contract." : `${d.type || "Document"} ingested.`, c);
    }
    // Commitments made in meetings, which is where the real history lives.
    for (const v of (c.analysis?.knowledge?.verbalCommitments || [])) {
      push(c.analysis?.analysedAt || c.updatedAt, "commitment",
           `Verbal: ${String(v.commitment || "").slice(0, 70)}`,
           `${v.saidBy || "Unattributed"} · ${v.inContract === "no" ? "NOT in the contract" : v.inContract === "yes" ? "reflected in the contract" : "unclear whether papered"}`, c);
    }
    if (c.analysis) {
      push(c.analysis.analysedAt || c.updatedAt, "analysis",
           `${c.ref} analysed`,
           `Grade ${c.analysis.riskGrade || "?"}${c.analysis.healthScore != null ? ` · health ${c.analysis.healthScore}/100` : ""}.`, c);
    }
    // The dates that are still ahead.
    if (c.endDate) {
      const end = new Date(c.endDate);
      const notice = new Date(end.getTime() - (c.noticePeriodDays || 90) * 86400000);
      const missed = notice < new Date();
      push(notice, missed ? "missed" : "notice",
           missed ? `NOTICE WINDOW MISSED — ${c.ref}` : `Notice deadline — ${c.ref}`,
           missed
             ? `This window closed ${Math.round((Date.now() - notice) / 86400000)} days ago.`
               + (c.autoRenew ? " The contract has auto-renewed or will do." : "")
             : `Last day to serve notice.${c.autoRenew ? " Auto-renews if missed." : ""}`, c);
      push(end, "end", `${c.ref} term ends`, `${c.autoRenew ? "Renews automatically unless notice served." : "Expires."}`, c);
    }
  }
  ev.sort((a, b) => a.date - b.date);
  return { contracts: mine, events: ev };
}

// ── PLAIN-ENGLISH GLOSSARY ────────────────────────────────────
// Stage 1 already asks the model to define the jargon in each contract,
// and until now that answer was generated and thrown away. This collects
// it across the portfolio, merges duplicate terms, and records which
// contracts each one came from.
function buildGlossary(contracts) {
  const map = new Map();
  for (const c of contracts) {
    for (const t of (c.analysis?.plainTerms || [])) {
      const term = String(t?.term || "").trim();
      const means = String(t?.means || "").trim();
      if (!term || !means) continue;
      const key = term.toLowerCase();
      if (!map.has(key)) map.set(key, { term, means, seenIn: [] });
      const e = map.get(key);
      // Keep the fullest definition offered across the estate.
      if (means.length > e.means.length) e.means = means;
      if (!e.seenIn.some((x) => x.id === c.id)) e.seenIn.push({ id: c.id, ref: c.ref, supplier: c.supplier });
    }
  }
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}

// A small built-in set so the glossary is useful before anything has been
// analysed. Deliberately short: these are the terms non-lawyers actually
// trip over, not a dictionary.
const BASE_GLOSSARY = [
  { term: "Auto-renewal (evergreen)", means: "The contract renews itself for another term unless you actively give notice. Miss the window and you are committed for another full period." },
  { term: "Consideration", means: "Something of value each side gives. Usually money one way and services the other. Without it there is no binding contract." },
  { term: "Force majeure", means: "Events outside anyone's control — floods, war, some strikes — that excuse a party from performing. Check whether it covers supplier failure or only true disasters." },
  { term: "Indemnity", means: "A promise to cover someone else's losses if a specific thing goes wrong. Broader than normal damages, and it can sit outside the liability cap." },
  { term: "Liability cap", means: "The maximum either side can be made to pay if things go wrong. Often twelve months' fees. Check what is excluded from it." },
  { term: "Liquidated damages", means: "A fixed sum agreed in advance for a specific failure, so nobody has to prove the actual loss." },
  { term: "Notice period", means: "How far in advance you must tell the other side you are leaving. The date you must act by, not the date the contract ends." },
  { term: "Novation", means: "Transferring the whole contract to a different company, with everyone's agreement. Different from assignment, which moves rights but not obligations." },
  { term: "Order of precedence", means: "Which document wins when two of them disagree. Usually the main agreement beats a schedule, which beats a purchase order." },
  { term: "Service credits", means: "Money back when the supplier misses agreed service levels. Often the only remedy, so check whether they are your sole recourse." },
  { term: "Severability", means: "If one clause turns out to be unenforceable, the rest of the contract survives rather than the whole thing collapsing." },
  { term: "Uplift / indexation", means: "The annual price rise. Often linked to CPI or RPI plus a percentage. Ask whether it is capped — uncapped uplift compounds." },
  { term: "Change of control", means: "What happens if one side is bought. May give the other party a right to terminate, which matters when a supplier is acquired." },
  { term: "Exit assistance", means: "Help moving to a new supplier at the end. Check how many days, and whether it is chargeable and at what rate." },
];

// ── PORTFOLIO OBLIGATIONS ────────────────────────────────────
// An obligation nobody owns is an obligation nobody does. Flattening every
// contract's register into one list with owners, due dates and status is
// what turns extraction into actual obligation management.
const obligationKey = (contractId, i) => `${contractId}::${i}`;
function allObligations(contracts, tracking) {
  const rows = [];
  for (const c of contracts) {
    (c.analysis?.obligations || []).forEach((o, i) => {
      const k = obligationKey(c.id, i);
      const t = tracking[k] || {};
      rows.push({ key: k, contract: c, obligation: o.obligation, party: o.owner, due: o.due,
        note: o.note, assignee: t.assignee || "", status: t.status || "open",
        completedAt: t.completedAt, dueDate: t.dueDate || "" });
    });
  }
  return rows;
}

// ── PORTFOLIO CLAUSE MATRIX ──────────────────────────────────
// AI-assisted clause comparison across the estate: which agreements are
// missing the protection you care about, seen in one grid.
function clauseMatrix(contracts) {
  const analysed = contracts.filter((c) => c.analysis?.compliance?.clauses?.length);
  const names = [...new Set(analysed.flatMap((c) => c.analysis.compliance.clauses.map((cl) => cl.clause)))].sort();
  const rows = names.map((clause) => ({
    clause,
    cells: analysed.map((c) => {
      const found = c.analysis.compliance.clauses.find((cl) => cl.clause === clause);
      return { contract: c, status: found?.status || "n/a", note: found?.note, confidence: found?.confidence };
    }),
  }));
  return { contracts: analysed, rows };
}

// ── KEY-PERSON / LEAVER RISK ─────────────────────────────────
// The differentiator: knowledge that exists only in someone's head, seen
// across the whole estate rather than one contract at a time.
function leaverRisk(contracts) {
  const bySpeaker = {};
  for (const c of contracts) {
    const a = c.analysis;
    if (!a?.knowledge) continue;
    for (const p of a.knowledge.points || []) {
      const who = (p.source || "unattributed").split(",")[0].trim();
      (bySpeaker[who] ||= { who, insights: [], commitments: [], contracts: new Set() });
      bySpeaker[who].insights.push({ contract: c, text: p.insight, matters: p.matters });
      bySpeaker[who].contracts.add(c.ref);
    }
    for (const v of a.knowledge.verbalCommitments || []) {
      const who = (v.saidBy || "unattributed").split("(")[0].trim();
      (bySpeaker[who] ||= { who, insights: [], commitments: [], contracts: new Set() });
      bySpeaker[who].commitments.push({ contract: c, text: v.commitment, inContract: v.inContract, action: v.action });
      bySpeaker[who].contracts.add(c.ref);
    }
  }
  return Object.values(bySpeaker)
    .map((s) => ({ ...s, contracts: [...s.contracts], total: s.insights.length + s.commitments.length }))
    .sort((a, b) => b.total - a.total);
}

// ── ASK CEDRIC ACTIONS ────────────────────────────────────────
// A library of ready-made questions. Two reasons this exists:
//
//   1. DISCOVERY. Most people never guess that Cedric can hold a
//      purchase order against the cap in the SOW above it. A blank
//      text box teaches nobody what the product can do.
//   2. CONSISTENCY. Free-form chat gives different answers depending
//      on how you ask. A fixed question gives a comparable answer
//      every time, which matters if you are running the same check
//      across forty contracts.
//
// Every action is deliberately generic — no company names, no figures,
// nothing specific to one customer. They work on any contract, and can
// be copied into any other tool without leaking anything.
const CEDRIC_ACTIONS = [
  // ── Renewal and notice ──
  { id: "ren-1", cat: "Renewal & notice", title: "When must I act?",
    what: "The date you have to serve notice by, not the date the contract ends.",
    prompt: "What is the notice deadline for this contract — the last date I can serve notice of non-renewal? State the exact date, how many days from today that is, whether the contract auto-renews if I miss it, and quote the clause you read it from." },
  { id: "ren-2", cat: "Renewal & notice", title: "Is the notice period consistent?",
    what: "Catches contracts that state different notice periods in different places.",
    prompt: "Check every document for statements about the notice period. If more than one figure appears anywhere — in the main terms, a schedule, an amendment or a commercial summary — list each figure with the clause it came from and tell me they conflict. Do not pick one." },
  { id: "ren-3", cat: "Renewal & notice", title: "What happens if I do nothing?",
    what: "The cost of letting it roll, stated plainly.",
    prompt: "If I take no action before the notice deadline, what happens? Cover the renewal term length, any price increase that applies on renewal, whether the increase is capped, and what the total cost of that renewal period would be." },
  { id: "ren-4", cat: "Renewal & notice", title: "Draft a notice of non-renewal",
    what: "A starting point for the letter, using the contract's own requirements.",
    prompt: "Draft a formal notice of non-renewal for this contract. Follow whatever the contract requires for valid notice — the recipient, the method of delivery, and the notice period. Keep it short and businesslike, and flag anything I need to fill in." },

  // ── Cost and savings ──
  { id: "cost-1", cat: "Cost & savings", title: "Where is the money?",
    what: "Ranked savings with the argument for each.",
    prompt: "List every saving available on this contract, ranked by how realistically winnable it is. For each one give an estimated annual value, the leverage I have, and the specific argument to make. Be honest about which ones are weak." },
  { id: "cost-2", cat: "Cost & savings", title: "Am I paying for things nobody uses?",
    what: "Dormant licences, unused modules, over-provisioned volume.",
    prompt: "Compare what this contract entitles us to against any usage or licence data that has been ingested. Identify anything we pay for and do not use — dormant seats, unused modules, over-provisioned volume — with the annual cost of each." },
  { id: "cost-3", cat: "Cost & savings", title: "How has the price moved?",
    what: "Uplift history and whether it is capped.",
    prompt: "Show the price history of this contract. What was the original charge, what is it now, and what uplift has been applied each year? Is there a cap on future increases, and if so what is it? If there is no cap, say so plainly." },
  { id: "cost-4", cat: "Cost & savings", title: "Prepare my negotiation position",
    what: "A one-page brief before you get on the call.",
    prompt: "Prepare a negotiation brief for this contract. Cover: our current position and spend, the three strongest asks in priority order, what we can concede, the supplier's likely counter-arguments, and our walk-away position. Keep it to one page." },

  // ── Risk and liability ──
  { id: "risk-1", cat: "Risk & liability", title: "What is my exposure?",
    what: "Liability caps, exclusions and what falls outside them.",
    prompt: "Explain my liability exposure under this contract. What is the cap, what does it apply to, what is excluded from it, and are there any uncapped liabilities? Compare that to what would be normal for a contract of this type and value." },
  { id: "risk-2", cat: "Risk & liability", title: "How badly can this end?",
    what: "The worst realistic outcome and what drives it.",
    prompt: "What is the worst realistic commercial outcome under this contract, and what would cause it? Cover termination costs, exit charges, notice traps, minimum commitments and any automatic extension. Give the figure where you can." },
  { id: "risk-3", cat: "Risk & liability", title: "Can I get out early?",
    what: "Termination rights and what they cost.",
    prompt: "What are my rights to terminate this contract early? Cover termination for convenience, for breach, and for insolvency. For each, state the notice required and any payment triggered. If there is no right to terminate for convenience, say so clearly." },
  { id: "risk-4", cat: "Risk & liability", title: "What if they fail to deliver?",
    what: "Service levels, credits and whether they are your only remedy.",
    prompt: "What happens if the supplier fails to meet the agreed service levels? Cover the measurement method, the service credits, any cap on those credits, whether credits are my sole remedy, and whether repeated failure gives me a right to terminate." },

  // ── Compliance and data ──
  { id: "comp-1", cat: "Compliance & data", title: "What clauses are missing?",
    what: "Checked against what a contract of this type should contain.",
    prompt: "Which clauses that I would normally expect in a contract of this type are missing or weak? For each, explain why it matters, what the risk is, and suggest the position I should ask for." },
  { id: "comp-2", cat: "Compliance & data", title: "Is the data protection adequate?",
    what: "Controller/processor roles, transfers, breach notice, sub-processors.",
    prompt: "Assess the data protection provisions. Cover controller and processor roles, the lawful basis for any transfers, breach notification timescales, sub-processor consent, audit rights and deletion on termination. Flag anything missing or below standard." },
  { id: "comp-3", cat: "Compliance & data", title: "Where does our data actually live?",
    what: "Residency, transfers and the safeguards behind them.",
    prompt: "Where is our data stored and processed under this contract? Identify the stated locations, any transfers outside them, the safeguards relied on, and whether we have the right to be told before that changes." },
  { id: "comp-4", cat: "Compliance & data", title: "What can I audit?",
    what: "Your inspection rights and their limits.",
    prompt: "What audit and inspection rights do I have? How often, on what notice, at whose cost, and what happens if an audit finds a problem? Note anything that limits those rights." },

  // ── Obligations ──
  { id: "ob-1", cat: "Obligations", title: "What do we have to do?",
    what: "Our side of the bargain, with dates.",
    prompt: "List every obligation this contract places on us, with the deadline or frequency for each. Mark anything that is overdue or falls in the next ninety days. Note which ones have a consequence attached if we miss them." },
  { id: "ob-2", cat: "Obligations", title: "What do they have to do?",
    what: "The supplier's commitments, and how to prove a breach.",
    prompt: "List every obligation this contract places on the supplier, with the deadline or frequency. For each, tell me how I would evidence a failure and what remedy the contract gives me." },
  { id: "ob-3", cat: "Obligations", title: "What is due this quarter?",
    what: "A short list you can act on now.",
    prompt: "What obligations, deadlines, reviews, reports or renewals fall due in the next ninety days? Give me a dated list in order, saying who owns each one if the contract names anybody." },

  // ── Supplier and consolidation ──
  { id: "sup-1", cat: "Supplier & consolidation", title: "How dependent are we?",
    what: "Concentration and lock-in, honestly assessed.",
    prompt: "How dependent are we on this supplier? Consider the share of spend, how easily we could switch, exit assistance in the contract, data portability, and anything that creates lock-in. Say plainly how strong our negotiating position is." },
  { id: "sup-2", cat: "Supplier & consolidation", title: "Could this be consolidated?",
    what: "Overlap with other agreements in the estate.",
    prompt: "Looking across the whole portfolio, does this contract overlap with any other agreement — the same supplier under a different name, or a different supplier providing a similar service? Estimate what combining them might be worth." },
  { id: "sup-3", cat: "Supplier & consolidation", title: "What is their risk to us?",
    what: "Third-party risk in plain terms.",
    prompt: "Assess this supplier as a third-party risk. Cover the criticality of what they provide, the insurance and security commitments in the contract, business continuity provisions, their access to our data or systems, and what would happen if they failed." },

  // ── Knowledge and people ──
  { id: "kn-1", cat: "Knowledge & people", title: "What was said but never written down?",
    what: "Verbal commitments checked against the signed terms.",
    prompt: "From any meeting transcripts, list commitments, concessions or assurances that do not appear in the signed contract. For each, say who said it, when, and whether it contradicts or merely supplements the written terms. Be clear these are not enforceable as they stand." },
  { id: "kn-2", cat: "Knowledge & people", title: "Who holds the history?",
    what: "Key-person risk on this relationship.",
    prompt: "Who in our organisation holds knowledge about this contract that exists nowhere in writing? What would we lose if they left tomorrow, and what should be documented before that happens?" },
  { id: "kn-3", cat: "Knowledge & people", title: "Brief me before the meeting",
    what: "Everything you need in the ten minutes beforehand.",
    prompt: "I have a meeting about this contract shortly. Give me a briefing: where we stand commercially, the live issues, what was agreed verbally that is not in the paperwork, the deadlines coming up, and the three questions I should ask." },

  // ── Cross-document ──
  { id: "xd-1", cat: "Cross-document checks", title: "Does the spend exceed the cap?",
    what: "Purchase orders against the limit in the SOW above them.",
    prompt: "Compare every purchase order and invoice against the value caps in the statements of work and the main agreement. Has the spend exceeded any cap? If so, by how much, and was a change order ever raised? Name both documents and the figures." },
  { id: "xd-2", cat: "Cross-document checks", title: "Do the documents contradict each other?",
    what: "Rates, dates, terms that disagree between files.",
    prompt: "Read every ingested document against the others and find contradictions — rates, payment terms, notice periods, dates or scope that disagree between documents. For each conflict, name both documents, quote both figures, and say which should prevail under the order of precedence." },
  { id: "xd-3", cat: "Cross-document checks", title: "Has an amendment changed the deal?",
    what: "What the amendments actually did to the original terms.",
    prompt: "Identify every amendment, variation or change order. For each, state what it changed from and to, when it took effect, and whether the current commercial position reflects the amended terms rather than the original." },
  { id: "xd-4", cat: "Cross-document checks", title: "Is anything unsigned or missing?",
    what: "Gaps in the paper trail.",
    prompt: "Reviewing everything ingested, what appears to be missing from the paper trail? Referenced schedules that are not present, unsigned documents, an amendment mentioned but not supplied, or a change agreed verbally with no corresponding paperwork." },
];

const CEDRIC_CATEGORIES = [...new Set(CEDRIC_ACTIONS.map((a) => a.cat))];

// ── REGULATORY POLICY PACKS (hot-swappable) ──────────────────
// Compliance rules are DATA, not code. An administrator can edit, add or
// retire a pack in Settings and it takes effect on the next analysis with
// no redeployment. In production these rows live in the `policy_packs`
// table and are fetched per-analysis, so a regulatory change is a database
// update rather than a release. Each pack declares the jurisdiction it
// applies to, so a contract governed by one regime is not graded against
// another's rules.
const DEFAULT_POLICY_PACKS = [
  {
    id: "uk-core", name: "UK core statutory", jurisdiction: "GB", version: "2026.1", active: true,
    rules: [
      "UK GDPR / Data Protection Act 2018 — processor terms, international transfer mechanism, sub-processor list, breach notification period.",
      "Bribery Act 2010 — anti-bribery and anti-corruption warranty.",
      "Modern Slavery Act 2015 — current-year supplier statement held where turnover threshold is met.",
      "Unfair Contract Terms Act 1977 — liability exclusions must be reasonable; no exclusion of death/personal injury from negligence.",
    ],
  },
  {
    id: "eu-gdpr", name: "EU GDPR", jurisdiction: "EU", version: "2026.1", active: true,
    rules: [
      "EU GDPR Arts. 28/32 — processor obligations and security of processing.",
      "Chapter V transfers — Standard Contractual Clauses or adequacy decision in place.",
      "Data subject rights assistance obligations flowed down to the supplier.",
    ],
  },
  {
    id: "us-state", name: "US state privacy (CCPA/CPRA et al.)", jurisdiction: "US", version: "2026.1", active: false,
    rules: [
      "CCPA/CPRA — service-provider clause restricting sale/sharing of personal information.",
      "Consumer rights request handling and deletion flow-down.",
      "State-specific addenda where the supplier processes resident data.",
    ],
  },
  {
    id: "commercial", name: "Commercial guardrails", jurisdiction: "ANY", version: "2026.1", active: true,
    rules: [
      "Liability cap present and proportionate to contract value.",
      "Termination for convenience with a defined notice period.",
      "Benchmarking or most-favoured-customer pricing mechanism.",
      "Defined exit assistance with agreed rates.",
      "Uplift cap tied to a published index.",
    ],
  },
];
const activePolicyBlock = (packs) => {
  const on = (packs || []).filter((p) => p.active);
  if (!on.length) return "";
  return "\n\nREGULATORY POLICY PACKS IN FORCE (assess the contract against every rule below; each becomes a compliance data point with its own confidence score):\n" +
    on.map((p) => `[${p.jurisdiction} · ${p.name} v${p.version}]\n` + p.rules.map((r) => `  - ${r}`).join("\n")).join("\n") + "\n";
};

// ── ACTUARIAL CONFIDENCE & HUMAN-IN-THE-LOOP ROUTING ─────────
// Every extracted data point carries a self-reported confidence score.
// IMPORTANT: a model's confidence is NOT a measured accuracy rate. It is an
// input to routing, not evidence of correctness. Real accuracy can only be
// established by benchmarking against a labelled gold-standard set (see
// calibration notes in the architecture guide). These tiers decide how much
// human attention a data point gets — which is what actually protects the
// user from a wrong extraction reaching a decision.
const HIL_TIERS = {
  deep:  { key: "deep",  min: 0,  max: 50,  label: "Deep review",   short: "Verify",
           colour: "#E0493E", bg: "#FDEEEC",
           action: "Mandatory manual verification and legal review before this value is relied upon." },
  light: { key: "light", min: 51, max: 80,  label: "Quick check",   short: "Check",
           colour: "#C98A1E", bg: "#FDF3E3",
           action: "Draft presented for rapid accept-or-edit. One click to confirm." },
  auto:  { key: "auto",  min: 81, max: 100, label: "Auto-accepted", short: "Auto",
           colour: "#2E9E6B", bg: "#EAF7F0",
           action: "Passed automatically. Recorded in the audit log and reversible." },
};
const hilTier = (score) => {
  const n = Number(score);
  if (!Number.isFinite(n)) return HIL_TIERS.deep;      // unknown confidence = treat as lowest
  if (n <= 50) return HIL_TIERS.deep;
  if (n <= 80) return HIL_TIERS.light;
  return HIL_TIERS.auto;
};
// A record is only "cleared" when nothing sits unverified below the auto threshold.
const openVerifications = (a) =>
  !a?.dataPoints ? [] : a.dataPoints.filter((d) => hilTier(d.confidence).key !== "auto" && d.status !== "accepted" && d.status !== "corrected");
const accuracyPosture = (a) => {
  const dp = a?.dataPoints || [];
  if (!dp.length) return null;
  const auto = dp.filter((d) => hilTier(d.confidence).key === "auto").length;
  const cleared = dp.filter((d) => d.status === "accepted" || d.status === "corrected").length;
  const mean = Math.round(dp.reduce((s, d) => s + (Number(d.confidence) || 0), 0) / dp.length);
  return { total: dp.length, auto, cleared, open: dp.length - auto - cleared, meanConfidence: mean };
};

const CREDIT_COST = {
  analysis: 10,   // full contract analysis
  cedric: 2,      // one question to Cedric
  revision: 0,    // re-analysis inside the revision window
};

const EDITIONS = {
  sandbox: {
    key: "sandbox",
    name: "Evaluation Sandbox",
    short: "Sandbox",
    price: "Free",
    credits: 150,
    windowDays: 90,
    windowLabel: "every 90 days",
    bank: 0,
    revisionDays: 0,      // every re-run consumes an audit
    playbook: false,      // custom playbook configuration
    crossClause: false,   // advanced cross-clause / cross-document logic
    zeroRetention: false,
    apiKeys: false,
    sso: false,
    features: [
      "150 credits every 90 days (about 2 analyses plus 65 questions)",
      "Standard risk triage dashboard",
      "Baseline metadata parsing",
      "Core clause checking routines",
    ],
  },
  growth: {
    key: "growth",
    name: "Growth / Professional",
    short: "Growth",
    price: "£79/month",
    credits: 500,
    windowDays: 30,
    windowLabel: "per month",
    bank: 500,
    revisionDays: 30,     // re-analysis inside 30 days is free
    playbook: true,
    crossClause: true,
    zeroRetention: false,
    apiKeys: false,
    sso: false,
    features: [
      "500 credits a month (about 12 analyses plus 190 questions)",
      "Unused credits roll over, up to 500",
      "30-day revision windows",
      "Custom playbook configuration",
      "Advanced cross-clause logic",
    ],
  },
  scale: {
    key: "scale",
    name: "Scale",
    short: "Scale",
    price: "£270/month",
    credits: 1800,
    windowDays: 30,
    windowLabel: "per month",
    bank: 1800,
    revisionDays: 30,
    playbook: true,
    crossClause: true,
    zeroRetention: false,
    apiKeys: false,
    sso: false,
    features: [
      "1,800 credits a month (about 45 analyses plus 675 questions)",
      "Unused credits roll over, up to 1,800",
      "Everything in Growth",
      "Priority analysis queue",
      "Quarterly portfolio review export",
    ],
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise Suite",
    short: "Enterprise",
    price: "£700/month",
    credits: 5000,
    windowDays: 30,
    windowLabel: "per month",
    bank: Infinity,
    revisionDays: 30,
    playbook: true,
    crossClause: true,
    zeroRetention: true,
    apiKeys: true,
    sso: true,
    features: [
      "5,000 credits a month, scaling on demand",
      "Dedicated API access keys",
      "Zero-Retention processing toggle",
      "Isolated cloud environments",
      "Corporate SSO",
    ],
  },
};

let ED = EDITIONS[EDITION];
const APP_NAME = "ContractIQ Platform";

// Entitlement as the database last reported it. Held at module level
// because the prompt builders above read ED while composing a request,
// and they are not React components. The component re-renders whenever
// this changes, so nothing reads a stale copy during a render.
let ENTITLEMENT = null;

// Merge what the plan INCLUDES (features, gates — product decisions that
// belong in the code) with what the account HAS (plan, allowance, period
// — billing facts that belong in the database). Display and entitlement
// are set together here, so the two cannot drift apart.
function applyEntitlement(ent) {
  ENTITLEMENT = ent || null;
  const key = ent?.plan && EDITIONS[ent.plan] ? ent.plan : FALLBACK_EDITION;
  EDITION = key;
  const base = EDITIONS[key];
  ED = {
    ...base,
    credits:    ent?.credits?.included ?? base.credits,
    windowDays: ent?.period_days ?? base.windowDays,
    windowLabel: (ent?.period_days ?? base.windowDays) === 30
      ? "per month" : `every ${ent?.period_days ?? base.windowDays} days`,
  };
  return ED;
}

const SAMPLE_ANALYSIS = {
  // Every data point carries a confidence score, the reasoning behind it, and a
  // traceable reference back to the source document. Scores drive H-I-L routing.
  plainTerms: [
    { term: "Evergreen renewal", means: "It renews itself every year unless you actively give notice in time." },
    { term: "Uplift (CPI + 3%)", means: "The price rises each year by inflation plus three percent, and it compounds." },
    { term: "Liability cap", means: "The most either side can be made to pay if things go wrong — here, twelve months' fees." },
    { term: "Service credits", means: "Money back when they miss the agreed service levels. Check whether it is your only remedy." },
    { term: "Minimum commitment", means: "A floor on what you must buy, whether or not you use it." },
  ],
  dataPoints: [
    { field: "annualValue", kind: "extraction", value: "£1,450,000", confidence: 94, reasoning: "Stated as a single annual figure in the commercial schedule with no conflicting value elsewhere.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — 'Annual Charges: GBP 1,450,000'" },
    { field: "endDate", kind: "extraction", value: "2027-03-31", confidence: 96, reasoning: "Explicit term end date in the signature schedule.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — 'expiring 31 March 2027'" },
    { field: "noticePeriodDays", kind: "extraction", value: "90", confidence: 88, reasoning: "Stated in words and digits; consistent across both the master terms and the order form.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — 'not less than ninety (90) days'" },
    { field: "autoRenew", kind: "extraction", value: "true", confidence: 91, reasoning: "Renewal clause states successive terms unless notice is served.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — 'shall automatically renew for successive periods'" },
    { field: "users", kind: "extraction", value: "4,200", confidence: 72, reasoning: "Seat count taken from the tracking spreadsheet, which may lag the contracted entitlement.", sourceRef: "licence_spend_tracker.xlsx — 'Allocated seats: 4200' (tracker, not contract)" },
    { field: "owner", kind: "extraction", value: "R. Sharma", confidence: 64, reasoning: "Named as commercial contact in the order form; may be the signatory rather than the current owner.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — signature block" },
    { field: "Uplift waiver precedent", kind: "risk", value: "2025 uplift waived after outage", confidence: 38, reasoning: "Reported verbally in a meeting and not evidenced in any written document — treat as a claim to verify.", sourceRef: "Q3_renewal_review_Teams.vtt — A. Whitfield (transcript only, unconfirmed)" },
    { field: "Benchmarking clause", kind: "clause", value: "missing", confidence: 47, reasoning: "Not found in the ingested extract, but the master agreement appears to be partial — absence may be an ingestion gap rather than a true omission.", sourceRef: "not found in ingested documents (document set may be incomplete)" },
    { field: "Limitation of liability", kind: "clause", value: "present — capped at 12 months' fees", confidence: 89, reasoning: "Clause located with an explicit cap; carve-outs stated separately.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — 'aggregate liability shall not exceed the charges paid in the preceding twelve months'" },
    { field: "Termination for convenience", kind: "clause", value: "missing", confidence: 83, reasoning: "Termination article located in full and contains only cause-based rights.", sourceRef: "Microsoft_Enterprise_Agreement.pdf — Article 11 (Termination) reviewed in full" },
  ],
  extracted: { name: "Enterprise Agreement", category: "Software & SaaS", annualValue: 1450000, currency: "GBP", startDate: "2024-04-01", endDate: "2027-03-31", noticePeriodDays: 90, autoRenew: true, owner: "R. Sharma", users: 4200 },
  healthScore: 62, riskGrade: "C",
  execSummary: "This agreement is commercially functional but carries avoidable cost and risk. Pricing has compounded through annual uplifts without benchmarking protection, licence allocation exceeds observed utilisation, and the auto-renewal mechanism narrows the negotiation window. Acting 6–9 months before expiry would materially strengthen the buyer's position.",
  cost: {
    summary: "Annual spend sits above mid-market benchmarks for this category, driven by historic uplifts of ~8% per year and an allocation of premium-tier licences across the full user base where a mixed tier profile would suffice. There is no benchmarking or most-favoured-customer clause to anchor pricing at renewal.",
    breakdown: [
      { label: "Licence over-provisioning", detail: "Roughly a quarter of allocated seats show no activity in 90 days; rightsizing at renewal is the largest single saving." },
      { label: "Annual uplift exposure", detail: "Uncapped CPI+ uplifts have compounded; negotiate a cap (e.g. CPI or 3%, whichever is lower)." },
      { label: "Premium-tier blanket allocation", detail: "Full-suite licences are assigned universally; a tiered profile matching actual feature usage would cut unit cost." },
    ],
    estimatedAnnualSaving: 217000,
  },
  users: {
    summary: "The user base is large and stable, but utilisation telemetry suggests a meaningful gap between allocated and active seats, concentrated in non-desk teams.",
    points: [
      "~25% of seats show no sign-in within the last 90 days.",
      "Feature usage clusters in core modules; premium modules see minimal adoption.",
      "Joiner/leaver process is not reclaiming licences promptly — automate deallocation.",
    ],
  },
  risks: [
    { title: "Auto-renewal with 90-day notice", severity: "high", detail: "Miss the notice window and the contract rolls at current terms plus uplift. Diarise notice 120 days out and issue a protective non-renewal notice to preserve leverage.", confidence: 91, sourceRef: "Microsoft_Enterprise_Agreement.pdf — renewal clause" },
    { title: "Uncapped price escalation", severity: "medium", detail: "No ceiling on annual increases. Cap uplifts and tie any increase to service performance.", confidence: 76, sourceRef: "Microsoft_Enterprise_Agreement.pdf — pricing schedule; no cap located" },
    { title: "Weak exit assistance provisions", severity: "medium", detail: "Limited obligations on the supplier to support migration; negotiate defined exit assistance at pre-agreed rates.", confidence: 44, sourceRef: "inferred: exit assistance referenced without service levels — document set may be incomplete" },
  ],
  opportunities: [
    { title: "Rightsize licence count", savingEstimate: "£130k/yr", detail: "Reduce to active-user levels with a quarterly true-up mechanism rather than fixed allocation." },
    { title: "Re-tier licence mix", savingEstimate: "£55k/yr", detail: "Move low-usage cohorts to standard tier; keep premium only where feature telemetry justifies it." },
    { title: "Cap annual uplifts", savingEstimate: "£32k/yr", detail: "Negotiate CPI-or-3% cap ahead of renewal while competitive tension exists." },
  ],
  compliance: {
    summary: "The agreement covers core protections but several clauses are weaker than standard UK enterprise positions, and two expected provisions could not be located in the ingested documents.",
    clauses: [
      { clause: "Limitation of liability", status: "present", confidence: 89, sourceRef: "Microsoft_Enterprise_Agreement.pdf — liability article", note: "Capped at 12 months' fees — within market norms, but check carve-outs for data breaches." },
      { clause: "Data protection / UK GDPR", status: "present", confidence: 85, sourceRef: "Microsoft_Enterprise_Agreement.pdf — data processing schedule", note: "Processor terms present; verify the sub-processor list and international transfer mechanism are current." },
      { clause: "Termination for convenience", status: "missing", confidence: 83, sourceRef: "Article 11 reviewed in full", note: "No buyer right to exit without cause — a key ask at renewal to maintain ongoing leverage." },
      { clause: "Benchmarking clause", status: "missing", confidence: 47, sourceRef: "not found — document set may be incomplete", note: "No mechanism to test pricing against market during the term." },
      { clause: "Audit rights", status: "unclear", confidence: 41, sourceRef: "referenced in master terms; scope not in ingested extract", note: "Referenced in the master terms but scope and frequency are not defined in ingested documents." },
      { clause: "Exit assistance", status: "unclear", confidence: 44, sourceRef: "mentioned without service levels", note: "Mentioned without defined service levels or rates — tighten before signature." },
    ],
    regulatory: [
      "UK GDPR / DPA 2018: processing terms present; confirm records of processing and transfer impact assessments are on file.",
      "Bribery Act 2010: anti-bribery warranty present in master terms.",
      "Modern Slavery Act 2015: supplier statement referenced; confirm current-year statement is held.",
    ],
  },
  obligations: [
    { obligation: "Serve renewal / non-renewal notice", owner: "us", due: "90 days before term end", note: "Miss it and the contract auto-renews at uplifted rates." },
    { obligation: "Quarterly service review meetings", owner: "supplier", due: "Quarterly", note: "Non-attendance weakens the service-credit evidence trail." },
    { obligation: "Annual security attestation", owner: "supplier", due: "Each contract year", note: "Chase if not received — required for compliance records." },
  ],
  knowledge: {
    summary: "Two recorded meetings add material context the paperwork does not carry: the supplier waived one year's uplift as a goodwill gesture after a service failure, a module the licence pays for has never been deployed, and the relationship history sits almost entirely with one departing colleague.",
    points: [
      { insight: "The 2025 uplift was waived after a major outage — a precedent the supplier has not repeated in writing.", source: "A. Whitfield, procurement review", matters: "Establishes that concessions are obtainable; useful leverage evidence at renewal." },
      { insight: "The analytics module included in the enterprise tier was never deployed after the pilot stalled.", source: "D. Okafor, procurement review", matters: "Paying premium tier for capability in active non-use — supports re-tiering." },
      { insight: "Renewal has historically been handled informally by email with the same account manager.", source: "A. Whitfield, procurement review", matters: "No documented negotiation trail; weakens the position if the account manager changes." },
    ],
    verbalCommitments: [
      { commitment: "Supplier indicated future uplifts would be 'kept reasonable' following the outage.", saidBy: "Supplier account manager (reported)", inContract: "no", action: "Unenforceable as stated — convert into a written uplift cap as a condition of renewal." },
      { commitment: "Additional onboarding support was offered at no charge for new business units.", saidBy: "Supplier account manager (reported)", inContract: "no", action: "Request written confirmation before relying on it in the rollout plan." },
    ],
    keyPersonRisk: [
      "The full history of the outage, the waiver and the informal renewal arrangement appears to be held by one colleague who is leaving — none of it is documented outside these meetings.",
      "Nobody else present could confirm why the premium tier was originally selected for all users.",
    ],
    openQuestions: [
      "Was the uplift waiver ever confirmed in writing, and does a side letter exist?",
      "What were the original business reasons for licensing the analytics module?",
      "Who inherits the supplier relationship, and has an introduction been made?",
    ],
  },
  insights: {
    negotiationLevers: [
      "Issue a protective non-renewal notice to reopen commercial terms without commitment.",
      "Bring utilisation data to the table — pay for active users, not allocated seats.",
      "Trade term length for price: a longer commitment is only worth giving for capped uplifts and termination for convenience.",
    ],
    recommendations: [
      "Begin renewal preparation 9 months before expiry; engage an alternative vendor to generate competitive tension.",
      "Automate licence reclamation in the joiner/leaver process this quarter.",
      "Request the missing benchmarking and termination-for-convenience clauses as conditions of renewal.",
    ],
    watchDates: [
      "Notice deadline: 90 days before term end — diarise at 120 days.",
      "Renewal negotiation window: open discussions 6–9 months out.",
      "Quarterly true-up dates if rightsizing is agreed.",
    ],
  },
};

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .ciq {
    font-family: 'Quicksand', 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
    background: #ffffff; color: #16283E; min-height: 100vh;
    -webkit-font-smoothing: antialiased; font-size: 15px; line-height: 1.55;
  }
  .ciq a { color: #2F7BD9; text-decoration: none; cursor: pointer; font-weight: 600; }
    /* Three zones, in the order research and habit both expect:
       identity + primary navigation on the left, a flexible gap, then
       global utilities (search, primary action, account) on the right.
       Previously everything was packed against the left edge, which is
       what made it read as clutter. */
  .nav {
      position: sticky; top: 0; z-index: 50; height: 62px;
    background: rgba(8,22,39,0.94); backdrop-filter: blur(14px);
    border-bottom: 1px solid rgba(95,168,245,0.16);
      display: flex; align-items: center; gap: 22px; padding: 0 22px;
    }
    .nav-left  { display: flex; align-items: center; gap: 22px; min-width: 0; }
    .nav-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
    .nav-sep   { width: 1px; height: 24px; background: rgba(95,168,245,0.22); }

    /* Active state is a filled pill, not a slightly different blue —
       a genuinely different treatment, so "where am I" is answerable
       at a glance. */
    .nav-item {
      cursor: pointer; font-size: 13px; font-weight: 600; color: #B9CFE8;
      padding: 7px 13px; border-radius: 7px; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
      transition: background .15s, color .15s;
    }
    .nav-item:hover { color: #fff; background: rgba(255,255,255,0.07); }
    .nav-item.on { color: #fff; background: rgba(47,123,217,0.34); box-shadow: inset 0 0 0 1px rgba(95,168,245,0.45); }

    .nav-search {
      background: rgba(255,255,255,0.08); border: 1px solid rgba(95,168,245,0.26);
      border-radius: 8px; padding: 7px 13px 7px 34px; font-size: 12.5px;
      font-family: inherit; font-weight: 500; color: #fff; width: 190px; outline: none;
      transition: width .2s, background .2s, border-color .2s;
    }
    .nav-search:focus { width: 250px; background: rgba(255,255,255,0.13); border-color: rgba(95,168,245,0.6); }
    .nav-search::placeholder { color: #7E9CC4; }

    .nav-avatar {
      width: 34px; height: 34px; border-radius: 50%; cursor: pointer;
      background: linear-gradient(150deg,#2F7BD9,#5FA8F5); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 12.5px; font-weight: 700; letter-spacing: 0.02em;
      border: 2px solid transparent; transition: border-color .15s;
    }
    .nav-avatar:hover, .nav-avatar.on { border-color: rgba(169,207,246,0.75); }

    .nav-menu {
      position: absolute; top: calc(100% + 10px); right: 0; z-index: 701; width: 288px;
      background: #fff; border: 1px solid #D6E3F5; border-radius: 11px;
      box-shadow: 0 22px 54px rgba(8,22,39,0.28); overflow: hidden;
    }
    .nav-menu-h {
      padding: 10px 15px 5px; font-size: 10.5px; font-weight: 700; color: #8FA3BC;
      text-transform: uppercase; letter-spacing: 0.07em;
      background: #F7FAFE; border-bottom: 1px solid #EEF3FA;
    }
    .nav-menu-i { padding: 10px 15px; cursor: pointer; border-bottom: 1px solid #F4F8FD; }
    .nav-menu-i:hover { background: #F7FAFE; }
    .nav-menu-i .t { font-size: 13.5px; font-weight: 700; color: #16283E; }
    .nav-menu-i .s { font-size: 11.5px; color: #7A8DA6; margin-top: 2px; }

    @media (max-width: 1180px) {
      .nav-search { width: 150px; }
      .nav-label-hide { display: none; }
    }
  .nav-brand { font-size: 18px; font-weight: 700; letter-spacing: 0.02em; cursor: pointer; color: #fff; display: flex; align-items: center; gap: 8px; }
  .nav-brand span { color: #5FA8F5; }
  .nav-links { display: flex; gap: 20px; font-size: 13px; font-weight: 600; color: #C7D8EE; align-items: center; }
  .nav-links div { cursor: pointer; transition: color .15s; letter-spacing: 0.02em; }
  .nav-links div:hover { color: #fff; }
  .user-chip { background: rgba(95,168,245,0.16); color: #A9CFF6; border: 1px solid rgba(95,168,245,0.3); border-radius: 100px; padding: 5px 13px; font-weight: 700; font-size: 11.5px; letter-spacing: 0.04em; }
  .hero {
    position: relative; text-align: center; padding: 62px 24px 52px; color: #fff; overflow: hidden;
    background: linear-gradient(135deg, #081627 0%, #0F2B4C 55%, #1C4E8F 100%);
  }
  .hero::before { content: ""; position: absolute; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'%3E%3Cg stroke='%23ffffff' stroke-opacity='0.07' fill='none'%3E%3Cpath d='M-20 180 L240 60 L520 200 L780 40 L1080 190 L1240 90'/%3E%3Cpath d='M240 60 L300 340 L520 200 M780 40 L740 320 L1080 190 M300 340 L740 320'/%3E%3Cpath d='M-40 620 L260 500 L560 660 L860 520 L1180 680'/%3E%3C/g%3E%3Cg fill='%23ffffff' fill-opacity='0.16'%3E%3Ccircle cx='240' cy='60' r='3'/%3E%3Ccircle cx='520' cy='200' r='3'/%3E%3Ccircle cx='780' cy='40' r='3'/%3E%3Ccircle cx='1080' cy='190' r='3'/%3E%3Ccircle cx='300' cy='340' r='3'/%3E%3Ccircle cx='740' cy='320' r='3'/%3E%3C/g%3E%3C/svg%3E") center/cover no-repeat; pointer-events: none; }
  .hero > * { position: relative; }
  .hero .eyebrow { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase; color: #A9CFF6; margin-bottom: 14px; }
  .hero .eyebrow::before, .hero .eyebrow::after { content: ""; width: 26px; height: 3px; background: #37D5C3; border-radius: 2px; }
  .hero h1 { font-size: clamp(30px, 4.4vw, 46px); font-weight: 700; letter-spacing: -0.01em; line-height: 1.12; }
  .hero h1 em { font-style: normal; color: #5FA8F5; }
  .hero p { font-size: 17px; color: #BFD5EF; margin-top: 12px; }
  .container { max-width: 1080px; margin: 0 auto; padding: 46px 28px 110px; }
  .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 0 0 44px; }
  /* Four-across stat strip used by the portfolio-level pages. This was
     referenced by Suppliers, Obligations, Knowledge and Vendor risk but
     never actually defined, so those rows stacked vertically. */
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .grid4 > div { background: #F5F9FE; border: 1px solid #E1EAF6; border-radius: 7px;
                 padding: 14px 16px; border-left: 3px solid #2F7BD9; }
  .grid4 .x { font-size: 24px; margin-top: 4px; }
  .stat { background: #F5F9FE; border-radius: 6px; padding: 22px; border-left: 4px solid #2F7BD9; }
  .stat .v { font-size: 27px; font-weight: 700; color: #0B1D33; }
  .stat .l { font-size: 11px; color: #62748B; margin-top: 5px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; }
  .section-title { font-size: 24px; font-weight: 700; color: #0B1D33; margin-bottom: 4px; }
  .section-sub { color: #62748B; font-size: 14.5px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
  .card { position: relative;
    background: #ffffff; border: 1px solid #E1EAF6; border-radius: 6px;
    padding: 26px; cursor: pointer; transition: all .2s; border-top: 3px solid #2F7BD9;
  }
  .card:hover { transform: translateY(-4px); box-shadow: 0 22px 48px rgba(15,43,76,0.14); border-color: rgba(95,168,245,0.55); border-top-color: #37D5C3; }
  .card .cat { font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #2F7BD9; }
  .card h3 { font-size: 19px; font-weight: 700; color: #0B1D33; margin: 8px 0 2px; }
  .card .sup { color: #62748B; font-size: 14px; font-weight: 600; }
  .card .meta { display: flex; justify-content: space-between; margin-top: 18px; font-size: 12.5px; color: #62748B; font-weight: 600; }
  .card .meta b { font-size: 15px; display: block; color: #16283E; }
  .pill { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 100px; padding: 4px 11px; margin-top: 14px; letter-spacing: 0.02em; }
  .pill.ok { background: #E4F8F0; color: #14805E; }
  .pill.warn { background: #FFF2E0; color: #A85A00; }

  .pill.teal { background: #E4F8F4; color: #12796B; }
  .pill.risk { background: #FDE9E7; color: #B23A31; }
  .pill.blue { background: #E5F0FD; color: #1D5FB8; }
  .btn {
    background: #2F7BD9; color: #fff; border: none; border-radius: 100px;
    padding: 11px 24px; font-size: 14px; font-weight: 700; cursor: pointer;
    font-family: inherit; letter-spacing: 0.02em; transition: all .18s;
  }
  .btn:hover { background: #5FA8F5; box-shadow: 0 8px 22px rgba(47,123,217,0.35); }
  .btn:disabled { background: #A9CFF6; cursor: default; box-shadow: none; }
  .btn.ghost { background: transparent; color: #2F7BD9; border: 1.5px solid rgba(47,123,217,0.5); }
  .btn.ghost:hover { background: rgba(47,123,217,0.07); box-shadow: none; }
  .btn.sm { padding: 8px 17px; font-size: 12.5px; }
  .add-card {
    border: 1.5px dashed rgba(47,123,217,0.4); border-radius: 6px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; min-height: 200px; cursor: pointer; color: #2F7BD9;
    transition: background .15s; background: #F5F9FE; font-weight: 700;
  }
  .add-card:hover { background: #E9F2FD; }
  .add-card .plus { width: 46px; height: 52px; background: linear-gradient(160deg, #2F7BD9, #5FA8F5); clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); color: #fff; font-size: 26px; font-weight: 500; display: flex; align-items: center; justify-content: center; line-height: 1; }
  .modal-bg { position: fixed; inset: 0; background: rgba(8,22,39,0.6); backdrop-filter: blur(5px); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: #fff; border-radius: 8px; border-top: 4px solid #2F7BD9; padding: 34px; width: 620px; max-width: 100%; max-height: 88vh; overflow-y: auto; }
  .modal h2 { font-size: 23px; font-weight: 700; color: #0B1D33; margin-bottom: 8px; }
  .modal .mh { color: #62748B; font-size: 14px; margin-bottom: 22px; line-height: 1.55; }
  .frow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .fld { margin-bottom: 13px; }
  .fld label { display: block; font-size: 11px; font-weight: 700; color: #62748B; margin-bottom: 7px; text-transform: uppercase; letter-spacing: 0.12em; }
  .fld input, .fld select, .fld textarea {
    width: 100%; border: 1.5px solid #D6E3F5; border-radius: 6px; padding: 11px 13px;
    font-size: 15px; font-family: inherit; font-weight: 500; background: #fff; color: #16283E; outline: none; transition: border .15s;
  }
  .fld input:focus, .fld select:focus, .fld textarea:focus { border-color: #2F7BD9; box-shadow: 0 0 0 3px rgba(47,123,217,0.12); }
  .detail-head { padding: 0 0 10px; }
  .detail-head .back { font-size: 13px; font-weight: 700; letter-spacing: 0.06em; color: #2F7BD9; cursor: pointer; margin-bottom: 16px; display: inline-block; text-transform: uppercase; }
  .detail-head h1 { font-size: 34px; font-weight: 700; color: #0B1D33; }
  .detail-head .sub { color: #62748B; font-size: 16px; margin-top: 5px; font-weight: 600; }
  .seg { display: inline-flex; background: #EDF4FC; border-radius: 100px; padding: 4px; margin: 26px 0 30px; flex-wrap: wrap; }
  .seg button {
    border: none; background: transparent; padding: 9px 18px; border-radius: 100px; font-size: 13px;
    font-weight: 600; color: #3D5473; cursor: pointer; font-family: inherit; transition: all .15s;
  }
  .seg button.on { background: #0F2B4C; color: #fff; font-weight: 700; }
  .panel { background: #F5F9FE; border-radius: 6px; padding: 26px; margin-bottom: 16px; border-left: 4px solid #2F7BD9; }
  .panel h4 { font-size: 16px; font-weight: 700; color: #0B1D33; margin-bottom: 10px; }
  .panel p, .panel li { font-size: 14.5px; line-height: 1.65; color: #3D4F66; }
  .panel ul { padding-left: 20px; margin-top: 6px; }
  .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; margin-top: 6px; }
  .kv .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.12em; color: #62748B; font-weight: 700; }
  .kv .x { font-size: 15px; font-weight: 700; margin-top: 3px; color: #16283E; }
  .item-row { display: flex; gap: 14px; background: #fff; border: 1px solid #E1EAF6; border-radius: 6px; padding: 16px 18px; margin-bottom: 10px; align-items: flex-start; transition: border .15s; }
  .item-row:hover { border-color: rgba(95,168,245,0.55); }
  .sev { width: 12px; height: 14px; clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); margin-top: 5px; flex-shrink: 0; }
  .sev.high { background: #E0493E; } .sev.medium { background: #EE9420; } .sev.low { background: #23A56F; }
  .item-row b { display: block; font-size: 15px; color: #0B1D33; margin-bottom: 2px; }
  .item-row span { font-size: 13.5px; color: #62748B; line-height: 1.55; display: block; }
  .save-tag { font-size: 12.5px; font-weight: 700; color: #14805E; background: #E4F8F0; border-radius: 6px; padding: 4px 10px; white-space: nowrap; }
  .doc-drop {
    border: 1.5px dashed rgba(47,123,217,0.4); border-radius: 6px; padding: 38px; text-align: center;
    color: #62748B; cursor: pointer; background: #F5F9FE; transition: background .15s; font-weight: 500;
  }
  .doc-drop:hover { background: #E9F2FD; }
  .doc-item { display: flex; align-items: center; justify-content: space-between; background: #F5F9FE; border-left: 3px solid #2F7BD9; border-radius: 6px; padding: 13px 16px; margin-top: 10px; font-size: 14px; }
  .doc-item .nm { font-weight: 700; color: #16283E; }
  .doc-item .tp { color: #62748B; font-size: 12px; margin-left: 8px; font-weight: 500; }
  .empty { text-align: center; padding: 60px 20px; color: #62748B; }
  .empty h3 { font-size: 20px; color: #0B1D33; font-weight: 700; margin-bottom: 6px; }
  .spin { display: inline-block; width: 15px; height: 15px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 50%; animation: sp .7s linear infinite; vertical-align: -3px; margin-right: 8px; }
  .spin.b { border-color: rgba(47,123,217,0.25); border-top-color: #2F7BD9; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .locked { display: flex; align-items: center; justify-content: space-between; gap: 14px; background: #F5F9FE; border: 1px dashed #C7DBF3; border-radius: 6px; padding: 15px 17px; margin-bottom: 16px; }
  .locked b { display: block; font-size: 14px; color: #56718A; }
  .locked span:not(.pill) { display: block; font-size: 12px; color: #7B8CA3; margin-top: 3px; line-height: 1.5; }
  .export-bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .footer { position: relative; background: #081627; color: #7E9CC4; padding: 30px 26px; text-align: center; font-size: 12.5px; font-weight: 600; overflow: hidden; }
  .footer::before { content: ""; position: absolute; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'%3E%3Cg stroke='%23ffffff' stroke-opacity='0.07' fill='none'%3E%3Cpath d='M-20 180 L240 60 L520 200 L780 40 L1080 190 L1240 90'/%3E%3Cpath d='M240 60 L300 340 L520 200 M780 40 L740 320 L1080 190 M300 340 L740 320'/%3E%3Cpath d='M-40 620 L260 500 L560 660 L860 520 L1180 680'/%3E%3C/g%3E%3Cg fill='%23ffffff' fill-opacity='0.16'%3E%3Ccircle cx='240' cy='60' r='3'/%3E%3Ccircle cx='520' cy='200' r='3'/%3E%3Ccircle cx='780' cy='40' r='3'/%3E%3Ccircle cx='1080' cy='190' r='3'/%3E%3Ccircle cx='300' cy='340' r='3'/%3E%3Ccircle cx='740' cy='320' r='3'/%3E%3C/g%3E%3C/svg%3E") center/cover; opacity: 0.5; }
  .footer a { position: relative; color: #A9C4E6; }
  .toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%); background: #0B1D33; color: #fff; border: 1px solid rgba(95,168,245,0.3); border-radius: 100px; padding: 12px 24px; font-size: 13.5px; font-weight: 600; z-index: 300; box-shadow: 0 12px 32px rgba(4,14,28,0.5); }

  /* ── Sign in ── */
  .login-wrap { position: relative; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #081627 0%, #0F2B4C 55%, #1C4E8F 100%); padding: 20px; overflow: hidden; }
  .login-wrap::before { content: ""; position: absolute; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'%3E%3Cg stroke='%23ffffff' stroke-opacity='0.07' fill='none'%3E%3Cpath d='M-20 180 L240 60 L520 200 L780 40 L1080 190 L1240 90'/%3E%3Cpath d='M240 60 L300 340 L520 200 M780 40 L740 320 L1080 190 M300 340 L740 320'/%3E%3Cpath d='M-40 620 L260 500 L560 660 L860 520 L1180 680'/%3E%3C/g%3E%3Cg fill='%23ffffff' fill-opacity='0.16'%3E%3Ccircle cx='240' cy='60' r='3'/%3E%3Ccircle cx='520' cy='200' r='3'/%3E%3Ccircle cx='780' cy='40' r='3'/%3E%3Ccircle cx='1080' cy='190' r='3'/%3E%3Ccircle cx='300' cy='340' r='3'/%3E%3Ccircle cx='740' cy='320' r='3'/%3E%3C/g%3E%3C/svg%3E") center/cover no-repeat; }
  .login { position: relative; background: #fff; border-radius: 8px; border-top: 4px solid #2F7BD9; padding: 44px 40px; width: 420px; max-width: 100%; box-shadow: 0 34px 90px rgba(4,14,28,0.55); }
  .login h1 { font-size: 28px; font-weight: 700; text-align: center; color: #0B1D33; }
  .login h1 span { color: #2F7BD9; }
  .login .tag { text-align: center; color: #62748B; font-size: 13.5px; font-weight: 600; margin: 8px 0 26px; }
  .login .tag::after { content: ""; display: block; width: 34px; height: 3px; background: #37D5C3; border-radius: 2px; margin: 12px auto 0; }
  .login .demo { font-size: 12px; color: #62748B; background: #F5F9FE; border-radius: 6px; padding: 12px 14px; margin-top: 16px; line-height: 1.6; }

  /* ── Cedric ── */
  .cedric-fab {
    position: fixed; right: 26px; bottom: 26px; z-index: 200;
    background: linear-gradient(135deg, #0F2B4C, #2F7BD9); color: #fff; border: 1px solid rgba(95,168,245,0.4); cursor: pointer;
    border-radius: 100px; padding: 14px 24px; font-size: 14.5px; font-weight: 700; font-family: inherit; letter-spacing: 0.02em;
    box-shadow: 0 14px 36px rgba(8,22,39,0.5); transition: transform .15s;
  }
  .cedric-fab:hover { transform: translateY(-2px); }
  .cedric {
    position: fixed; right: 20px; bottom: 20px; z-index: 250; width: 400px; max-width: calc(100vw - 40px);
    height: 560px; max-height: calc(100vh - 100px); background: #fff; border-radius: 8px;
    box-shadow: 0 30px 80px rgba(4,14,28,0.55); display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid rgba(95,168,245,0.3);
  }
  .cedric-head { position: relative; background: linear-gradient(135deg, #081627, #1C4E8F); color: #fff; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; overflow: hidden; }
  .cedric-head::before { content: ""; position: absolute; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'%3E%3Cg stroke='%23ffffff' stroke-opacity='0.07' fill='none'%3E%3Cpath d='M-20 180 L240 60 L520 200 L780 40 L1080 190 L1240 90'/%3E%3Cpath d='M240 60 L300 340 L520 200 M780 40 L740 320 L1080 190 M300 340 L740 320'/%3E%3Cpath d='M-40 620 L260 500 L560 660 L860 520 L1180 680'/%3E%3C/g%3E%3Cg fill='%23ffffff' fill-opacity='0.16'%3E%3Ccircle cx='240' cy='60' r='3'/%3E%3Ccircle cx='520' cy='200' r='3'/%3E%3Ccircle cx='780' cy='40' r='3'/%3E%3Ccircle cx='1080' cy='190' r='3'/%3E%3Ccircle cx='300' cy='340' r='3'/%3E%3Ccircle cx='740' cy='320' r='3'/%3E%3C/g%3E%3C/svg%3E") center/cover; }
  .cedric-head > * { position: relative; }
  .cedric-head b { font-size: 16px; }
  .cedric-head .sc { font-size: 11.5px; color: #A9CFF6; margin-top: 3px; font-weight: 600; }
  .cedric-head button { background: rgba(255,255,255,0.15); border: none; color: #fff; border-radius: 100px; width: 28px; height: 28px; cursor: pointer; font-size: 13px; }
  .cedric-msgs { flex: 1; overflow-y: auto; padding: 18px; background: #F5F9FE; }
  .cmsg { max-width: 85%; border-radius: 8px; padding: 12px 15px; font-size: 13.5px; line-height: 1.55; margin-bottom: 10px; white-space: pre-wrap; font-weight: 500; }
  .cmsg.user { background: #2F7BD9; color: #fff; margin-left: auto; border-bottom-right-radius: 2px; }
  .cmsg.bot { background: #fff; border: 1px solid #E1EAF6; border-left: 3px solid #37D5C3; border-bottom-left-radius: 2px; color: #16283E; }
  @keyframes ciqpulse { 0%,100% { box-shadow: 0 0 0 0 rgba(224,73,62,0.45); } 50% { box-shadow: 0 0 0 7px rgba(224,73,62,0); } }
  .cedric-input { display: flex; gap: 8px; align-items: center; padding: 12px; border-top: 1px solid #E1EAF6; background: #fff; }
  .cedric-input input { flex: 1; border: 1.5px solid #D6E3F5; border-radius: 100px; padding: 10px 16px; font-size: 13.5px; font-family: inherit; font-weight: 500; outline: none; }
  .cedric-input input:focus { border-color: #2F7BD9; }
  .cedric-sugs { padding: 0 18px 8px; display: flex; gap: 6px; flex-wrap: wrap; background: #F5F9FE; }
  .cedric-sugs button { background: #E5F0FD; color: #1D5FB8; border: none; border-radius: 100px; padding: 6px 13px; font-size: 11.5px; font-weight: 700; cursor: pointer; font-family: inherit; }
  @media (max-width: 760px) { .stat-row { grid-template-columns: 1fr 1fr; } .grid4 { grid-template-columns: 1fr 1fr; } .frow { grid-template-columns: 1fr; } }
  @media (max-width: 900px) { .nav-links .pub, .nav-links .user-chip { display: none; } .nav-links { gap: 14px; } }
`;

const fmtMoney = (v, c = "GBP") =>
  v == null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: c || "GBP", maximumFractionDigits: 0 }).format(v);

const daysTo = (d) => (d ? Math.round((new Date(d) - new Date()) / 86400000) : null);

const renewalPill = (ct) => {
  const d = daysTo(ct.endDate);
    // Before an end date is known, say where the record actually IS rather
    // than "Awaiting ingestion" regardless. Somebody who has just uploaded
    // two files should be able to see that the upload worked.
    if (d == null) {
      const docs = (ct.documents || []).filter((x) => !x.purged);
      const readable = docs.filter((x) => x.text && x.text.trim().length > 40);
      if (!docs.length) return <span className="pill blue">Awaiting documents</span>;
      if (!readable.length) return <span className="pill warn">{docs.length} file{docs.length === 1 ? "" : "s"} · needs OCR</span>;
      if (!ct.analysis) return <span className="pill teal">{readable.length} file{readable.length === 1 ? "" : "s"} ready to analyse</span>;
      return <span className="pill blue">Analysed · no end date found</span>;
    }
  if (d < 0) return <span className="pill risk">Expired</span>;
  if (d <= 180) return <span className="pill warn">Renews in {d} days</span>;
  return <span className="pill ok">Active · {Math.round(d / 30)} mo left</span>;
};

// Escape untrusted strings before inserting into export HTML (XSS hygiene).
// AI output and user input must never reach an HTML context unescaped.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Credential hashing (SHA-256 via WebCrypto). No plaintext passwords exist
// anywhere in this source or in memory beyond the sign-in keystrokes.
// DEMO-GRADE ONLY: production replaces this entire mechanism with Supabase
// Auth (server-side bcrypt, session tokens). Never roll your own auth for
// real users.
async function hashCred(username, password) {
  const data = new TextEncoder().encode(`${String(username).toLowerCase()}:${password}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const ADMIN_BYPASS_HASH = "8a331fbee98a1dce4c0db1c9f6838b7d9b8c4d019bd6c2822a778d511b987972";

const seedUsers = [
  { username: "admin", passHash: "8cb0873fee1ffb16d96cbd87344631b617d5a7b1fa248ab9d1111b24b5c18b0a", displayName: "Admin", role: "Admin" },
  { username: "guest", passHash: "484f69eed0087f49d90fa9e732609d69a56815ab3089b99a1427280457d77c66", displayName: "Guest User", role: "Viewer" },
];

// Sample portfolio — NOT loaded by default. A new workspace starts empty.
// Available on demand from Settings (or the first-run panel) so the product
// can still be demonstrated with realistic data without a new customer
// inheriting someone else's contracts.
const SAMPLE_PORTFOLIO = [
  {
    id: "c1", ref: "CTR-0001", supplier: "Microsoft", name: "Enterprise Agreement", category: "Software & SaaS",
    annualValue: 1450000, currency: "GBP", startDate: "2024-04-01", endDate: "2027-03-31",
    noticePeriodDays: 90, autoRenew: true, owner: "R. Sharma", users: 4200,
    notes: "E5 licences, Azure commit included. Historic 8% YoY uplift.", documents: [], analysis: null,
  },
  {
    id: "c2", ref: "CTR-0002", supplier: "ServiceMax", name: "Field Scheduling Platform", category: "Software & SaaS",
    annualValue: 380000, currency: "GBP", startDate: "2023-09-01", endDate: "2026-08-31",
    noticePeriodDays: 180, autoRenew: true, owner: "C. Godwani", users: 1150,
    notes: "Per-user licensing. Usage report suggests ~30% of licences dormant.", documents: [], analysis: null,
  },
  {
    id: "c3", ref: "CTR-0003", supplier: "Nokia", name: "Network Maintenance MSA", category: "Telecoms & Network",
    annualValue: 2100000, currency: "GBP", startDate: "2022-01-01", endDate: "2026-12-31",
    noticePeriodDays: 120, autoRenew: false, owner: "R. Baxi", users: 0,
    notes: "Includes SLA credits regime. SOW-driven spend on top of base fee.", documents: [], analysis: null,
  },
];

// A new workspace starts genuinely empty.
const seedContracts = [];

const docContext = (ct) =>
  ct.documents.map((d) => d.type === "Meeting transcript"
    ? `--- MEETING TRANSCRIPT: ${d.name}${d.speakers?.length ? ` (participants: ${d.speakers.join(", ")})` : ""} ---\n${d.text || "(not readable)"}`
    : `--- ${d.name} (${d.type}) ---\n${d.text || "(binary file — metadata only)"}`).join("\n\n");

// Long-document context: keep the head (definitions, commercial terms) and
// tail (schedules, signatures) rather than blind-truncating the middle away.
const clipContext = (s, max = 55000) =>
  s.length <= max ? s : s.slice(0, Math.floor(max * 0.75)) + "\n\n[…middle of documents omitted for length…]\n\n" + s.slice(-Math.floor(max * 0.25));

// ── Real document parsing (pdf.js + SheetJS from cdnjs) ───────
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("script load failed"));
    document.head.appendChild(s);
  });
}
async function extractPdfText(file) {
  if (!window.pdfjsLib) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  const n = Math.min(pdf.numPages, 80); // cap very long contracts
  for (let i = 1; i <= n; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => it.str).join(" "));
  }
  const text = pages.join("\n\n") + (pdf.numPages > n ? `\n\n[${pdf.numPages - n} further pages not extracted]` : "");
  // A scanned contract is an image of a page: pdf.js finds almost no text
  // layer. Rather than silently cataloguing it by metadata (and analysing
  // nothing), flag it so the user can run OCR.
  const perPage = text.replace(/\s+/g, "").length / Math.max(1, n);
  return { text, scanned: perPage < 80, pageCount: pdf.numPages };
}

// ── OCR for scanned contracts ─────────────────────────────────
// Runs entirely in the browser via tesseract.js — the document never
// leaves the machine. Loaded on demand because the language model is a
// large download and most contracts are digital and never need it.
async function runOcrOnFile(file, onProgress) {
  if (!window.Tesseract) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js");
  }
  if (!window.pdfjsLib) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const isPdf = /\.pdf$/i.test(file.name);
  const worker = await window.Tesseract.createWorker("eng");
  const out = [];
  try {
    if (isPdf) {
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const n = Math.min(pdf.numPages, 30);   // OCR is slow; cap for sanity
      for (let i = 1; i <= n; i++) {
        onProgress?.({ page: i, total: n, stage: "reading" });
        const page = await pdf.getPage(i);
        // 2x scale materially improves character recognition on scans.
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const { data } = await worker.recognize(canvas);
        out.push(data.text || "");
        canvas.width = canvas.height = 0;      // release memory between pages
      }
      if (pdf.numPages > n) out.push(`[${pdf.numPages - n} further pages not processed]`);
    } else {
      onProgress?.({ page: 1, total: 1, stage: "reading" });
      const { data } = await worker.recognize(file);
      out.push(data.text || "");
    }
  } finally {
    await worker.terminate();
  }
  return out.join("\n\n");
}
const isTranscript = (name) =>
  /\.(vtt|srt)$/i.test(name) || /transcript|meeting|minutes|teams|zoom|call[-_ ]?notes|recording/i.test(name);

// ── Meeting transcripts (Teams / Zoom) ────────────────────────
// Teams exports .vtt or .docx; Zoom exports .vtt, .srt or a plain .txt.
// Raw cue files are mostly timestamps, so we strip the scaffolding and
// merge consecutive turns by the same speaker into readable dialogue —
// which is both cheaper to send for analysis and far easier for the model
// to reason over than 900 two-second fragments.
function parseTranscript(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const turns = [];
  let lastSpeaker = null;
  for (let ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (/^WEBVTT/i.test(t) || /^NOTE\b/i.test(t) || /^\d+$/.test(t)) continue;      // headers, cue numbers
    if (/-->/.test(t)) continue;                                                   // timestamp lines
    if (/^<v\s/i.test(t)) {                                                        // Teams <v Speaker>text</v>
      const m = t.match(/^<v\s+([^>]+)>([\s\S]*?)(<\/v>)?$/i);
      if (m) { pushTurn(m[1].trim(), m[2].trim()); continue; }
    }
    const sp = t.match(/^([A-Z][\w .'-]{1,40}):\s*(.*)$/);                          // "Name: text"
    if (sp) { pushTurn(sp[1].trim(), sp[2].trim()); continue; }
    pushTurn(lastSpeaker, t.replace(/<[^>]+>/g, ""));
  }
  function pushTurn(speaker, text) {
    if (!text) return;
    text = text.replace(/<[^>]+>/g, "").trim();
    if (!text) return;
    if (speaker && speaker === lastSpeaker && turns.length) { turns[turns.length - 1].text += " " + text; return; }
    if (!speaker) {
      if (turns.length) { turns[turns.length - 1].text += " " + text; return; }
      speaker = "Unattributed";
    }
    lastSpeaker = speaker;
    turns.push({ speaker, text });
  }
  const out = turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
  const speakers = [...new Set(turns.map((t) => t.speaker))];
  return { text: out, speakers };
}

async function extractDocxText(file) {
  if (!window.mammoth) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
  const res = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return res.value || "";
}

async function extractExcelText(file) {
  if (!window.XLSX) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
  return wb.SheetNames.slice(0, 8)
    .map((nm) => `--- sheet: ${nm} ---\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[nm]))
    .join("\n\n");
}

// Resolve which contract a question refers to — requires a meaningful mention
// of a contract ref (or its number), name, or supplier. Longest match wins.
function matchContract(question, contracts) {
  const q = (question || "").toLowerCase();
  let best = null, bestLen = 0;
  for (const c of contracts) {
    for (const k of [c.ref, c.name, c.supplier].filter(Boolean)) {
      const kl = String(k).toLowerCase();
      if (kl.length >= 3 && q.includes(kl) && kl.length > bestLen) { best = c; bestLen = kl.length; }
    }
    const num = String(c.ref || "").replace(/\D/g, "");
    if (num.length >= 3 && q.includes(num) && num.length > bestLen) { best = c; bestLen = num.length; }
  }
  return best;
}

// ── AI analysis + detail extraction ───────────────────────────
// The analysis is built from THREE calls, not one.
//
// A single request asking for every section at once produced out:8000 on a
// contract with only 4,017 input tokens — the model hit the output ceiling
// mid-JSON and the whole thing was lost. Output length tracks how much
// there is to say, so a bigger ceiling just moves the wall further out.
//
// Each stage below asks for one coherent slice, fits comfortably, and
// parses on its own. If stage three fails you keep stages one and two
// rather than losing the lot.
function analysisContextFor(contract, customPlaybook, policyPacks) {
  const playbookBlock = (ED.playbook && customPlaybook?.trim())
    ? `\n\nCUSTOM PLAYBOOK — this organisation's own vetting rules. Grade the contract against THESE positions; every deviation is a finding:\n${customPlaybook.trim()}`
    : "";
  const packs = (policyPacks || []).filter((p) => p.on);
  const policyBlock = packs.length
    ? `\n\nREGULATORY POLICY PACKS IN FORCE:\n${packs.map((p) => `${p.name} (v${p.version}):\n${p.rules.map((r) => "  - " + r).join("\n")}`).join("\n\n")}`
    : "";

  return `CONTRACT RECORD:
${JSON.stringify({ ...contract, documents: undefined, analysis: undefined }, null, 2)}

INGESTED DOCUMENTS:
${clipContext(docContext(contract)) || "(none ingested yet — analyse from record details alone and flag what documents would improve the analysis)"}${playbookBlock}${policyBlock}

MEETING TRANSCRIPTS: any document marked "MEETING TRANSCRIPT" records what people said, not a contractual term. Mine it for history the paperwork omits, verbal assurances never written down, workarounds, and who holds which relationship. Attribute to the speaker. NEVER present something said in a meeting as a contractual obligation.

CONFIDENCE SCORING — a safety mechanism, not a formality:
 - 81-100 ONLY when stated explicitly and unambiguously and you can quote the phrase.
 - 51-80 when stated but ambiguous, oddly formatted, spread across documents, or lightly inferred.
 - 0-50 when inferred, contradicted between documents, taken from a transcript, or genuinely uncertain.
Never score above 50 for anything from a transcript alone. When torn between two bands, choose the lower. A wrongly-high score sends a bad value straight into a commercial decision; under-confidence costs only a few seconds of checking.

Return ONLY valid JSON. No prose before or after, no code fences. Keep every string tight — one or two sentences unless asked otherwise.`;
}

// ── THE FIVE STAGES ───────────────────────────────────────────
// Every schema below states a maximum number of items and a maximum
// length per item. Without those caps the model writes as much as the
// contract deserves, which on a complex agreement is unbounded — and no
// token ceiling survives unbounded. Caps make the output predictable
// whatever you feed in.
const LENGTH_RULES = `
LENGTH DISCIPLINE — this is a hard requirement, not a style note:
 - Respect every "max" below. Returning more items than asked for causes the response to be cut off and LOST.
 - Prefer the most material findings. Six sharp entries beat twenty thin ones.
 - Keep every "detail", "note" and "reasoning" to ONE sentence unless the schema says otherwise. Never more than two.
 - No preamble, no closing remarks, no markdown, no code fences. JSON only.`;

// Stage 1 · what the contract actually says. Proven at ~3-4k tokens.
function stage1Prompt(contract, customPlaybook, policyPacks) {
  return `You are ContractIQ, an expert contract and commercial analyst. Extract the facts of this contract.

${analysisContextFor(contract, customPlaybook, policyPacks)}
${LENGTH_RULES}

Return exactly this shape:
{
  "extracted": {
    "name": <string|null>, "category": <string|null>, "annualValue": <number|null>,
    "currency": <string|null>, "startDate": <"YYYY-MM-DD"|null>, "endDate": <"YYYY-MM-DD"|null>,
    "noticePeriodDays": <number|null>, "autoRenew": <boolean|null>, "owner": <string|null>,
    "users": <number|null>, "paymentTerms": <string|null>, "upliftMechanism": <string|null>
  },
  "dataPoints": [   // one per NON-NULL field above, max 12
    { "field": "<key from extracted>", "kind": "extraction", "value": "<value as text>",
      "confidence": <0-100>, "reasoning": "<ONE sentence>",
      "sourceRef": "<document + short quoted phrase, or 'inferred: <basis>', or 'not found in ingested documents'>" }
  ],
  "plainTerms": [ { "term": "<jargon or defined term>", "means": "<ONE plain sentence>" } ],   // max 8
  "execSummary": "<3-4 sentences: what this is, what it costs, when it ends, the one thing to watch>",
  "healthScore": <0-100 integer>,
  "riskGrade": <"A"|"B"|"C"|"D"|"F">
}
Use null where the documents do not say. Never take contract values or dates from a transcript alone.`;
}

// Stage 2 · the money.
function stage2Prompt(contract, customPlaybook, policyPacks) {
  return `You are ContractIQ, an expert contract and commercial analyst. Assess the commercial position only.

${analysisContextFor(contract, customPlaybook, policyPacks)}
${LENGTH_RULES}

Return exactly this shape:
{
  "cost": {
    "summary": "<max 4 sentences: current position, trajectory, how it compares to market>",
    "breakdown": [ { "label": "<cost element>", "detail": "<ONE sentence>" } ],   // max 6
    "estimatedAnnualSaving": <number|null>
  },
  "users": {
    "summary": "<max 3 sentences on seats, licences or volume>",
    "points": ["<ONE sentence observation>"]   // max 5
  }
}
If usage or licence data is present, compare entitlement against actual use and quantify anything dormant.`;
}

// Stage 3 · exposure and upside.
function stage3Prompt(contract, customPlaybook, policyPacks) {
  return `You are ContractIQ, an expert contract and commercial analyst. Identify risks and savings only.

${analysisContextFor(contract, customPlaybook, policyPacks)}
${LENGTH_RULES}

Return exactly this shape:
{
  "risks": [   // MAX 8, most material first
    { "title": "<short label>", "severity": "high|medium|low",
      "detail": "<max 2 sentences: what it means and how to mitigate>",
      "confidence": <0-100>, "sourceRef": "<document + short quote, or basis of inference>" }
  ],
  "opportunities": [   // MAX 6, most winnable first
    { "title": "<short label>", "savingEstimate": "<e.g. '£85k/yr' or 'not quantifiable'>",
      "detail": "<max 2 sentences: how to realise it and what leverage you have>" }
  ]
}
If documents contradict each other on a figure or a date, raise that as a risk rather than picking one.`;
}

// Stage 4 · what must be done, and what is missing.
function stage4Prompt(contract, customPlaybook, policyPacks) {
  return `You are ContractIQ, an expert contract and commercial analyst. Cover compliance and obligations only.

${analysisContextFor(contract, customPlaybook, policyPacks)}
${LENGTH_RULES}

Return exactly this shape:
{
  "compliance": {
    "summary": "<max 3 sentences>",
    "clauses": [   // MAX 12 — the clauses that matter for a contract of this type
      { "clause": "<e.g. Liability cap>", "status": "present|missing|unclear",
        "note": "<ONE sentence: what it says, or what its absence exposes>" }
    ],
    "regulatory": ["<ONE string per area, e.g. 'UK GDPR / DPA 2018: processing terms present; confirm records of processing are held.'>"]   // max 5
  },
  "obligations": [   // MAX 10
    { "obligation": "<what must be done>", "owner": "<us|supplier>",
      "due": "<YYYY-MM-DD or a frequency such as 'quarterly'>",
      "note": "<ONE sentence: what happens if it is missed>" }
  ]
}
Assess against standard UK enterprise practice (UK GDPR / Data Protection Act 2018, Bribery Act 2010, Modern Slavery Act 2015 where relevant). Mark "unclear" where the documents are insufficient to judge — do not guess.`;
}

// Stage 5 · the things that live in people's heads.
function stage5Prompt(contract, customPlaybook, policyPacks) {
  return `You are ContractIQ, an expert contract and commercial analyst. Cover institutional knowledge and the actions arising.

${analysisContextFor(contract, customPlaybook, policyPacks)}
${LENGTH_RULES}

Return exactly this shape:
{
  "knowledge": {
    "summary": "<max 3 sentences on undocumented context>",
    "points": ["<ONE sentence, attributed to who said it and where>"],   // max 6
    "verbalCommitments": [   // max 6
      { "commitment": "<what was promised>", "saidBy": "<speaker and meeting>",
        "inContract": "yes|no|unclear", "action": "<ONE sentence: what to do about it>" }
    ],
    "keyPeople": [ { "name": "<person>", "holds": "<ONE sentence: what only they know>" } ],   // max 5
    "keyPersonRisk": ["<ONE sentence per person: what would be lost if they left>"],   // max 4
    "openQuestions": ["<ONE question the documents do not answer>"]   // max 5
  },
  "insights": {
    "negotiationLevers": ["<ONE sentence per lever>"],        // max 6
    "recommendations": ["<action + when to take it, ONE sentence>"],   // max 6
    "watchDates": ["<date or window + why it matters, ONE sentence>"],  // max 5
    "reviewStartDate": "<YYYY-MM-DD — when to BEGIN the renewal review, working back from the notice deadline>",
    "reviewLeadTimeWeeks": <number>
  }
}
If no transcripts are present, still return "knowledge" with empty arrays and a summary saying so. reviewStartDate must leave realistic time to benchmark, gather stakeholders and negotiate before the notice deadline falls.`;
}

// Kept for the queued path, which sends one prompt to the worker.
function analysisPromptFor(contract, customPlaybook, policyPacks) {
  return stage1Prompt(contract, customPlaybook, policyPacks);
}

// Short, stable fingerprint used as an idempotency key. Two identical
// requests collapse onto one job rather than being charged twice.
async function sha256Short(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s || ""));
  return Array.from(new Uint8Array(buf)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

const buildAnalysisPrompt = (contract, customPlaybook, policyPacks) =>
  analysisPromptFor(contract, customPlaybook, policyPacks);

// Turn an HTTP status into something a person can act on. The old message
// was "Analysis API 500", which named the symptom and nothing else.
function explainAiFailure(status, detail) {
  const d = (detail || "").toLowerCase();
  if (status === 401) {
    // Verify JWT is now ON, deliberately — that is what stops a stranger
    // spending your Anthropic balance. A 401 means the session, not the setting.
    return detail || "Your session has expired. Sign in again and retry — nothing has been charged.";
  }
  if (status === 403) {
    if (d.includes("origin")) return "Your AI function rejected this site. The ALLOWED_ORIGIN secret in Supabase must exactly match this app's address — https:// and the domain only, no folder and no trailing slash.";
    return detail || "This sign-in is not attached to a workspace yet.";
  }
  if (status === 402) {
    // Out of credits. The message from the server already names the cost
    // and the balance, so pass it straight through.
    return detail || "This workspace is out of credits.";
  }
  if (status === 429) {
    // Now a per-account limit held in the database, not a counter in the
    // function's memory that reset on every cold start.
    return (detail || "This workspace has reached its hourly limit.")
      + " The limit is per workspace and per hour; change it in the ai_limits table.";
  }
  if (status === 500) {
    if (d.includes("missing") || d.includes("api_key") || d.includes("anthropic_api_key"))
      return "Your API key is not reaching the function. In Supabase → Edge Functions → Secrets, check ANTHROPIC_API_KEY is spelled exactly that way and holds the full sk-ant-… key.";
    if (d.includes("credit") || d.includes("balance"))
      return "Your Anthropic account is out of credit. Top up at console.anthropic.com.";
    return "The AI function failed. Check Supabase → Edge Functions → anthropic-proxy → Logs for the reason." + (detail ? ` (${detail})` : "");
  }
  if (status === 502) return "The AI function could not reach Anthropic. Usually temporary — try again in a moment.";
  if (status === 529 || d.includes("overloaded")) return "Anthropic is busy right now. Wait a minute and try again — nothing is wrong with your setup.";
  if (status === 400 && d.includes("credit")) return "Your Anthropic account is out of credit. Top up at console.anthropic.com.";
  return `The AI request failed (HTTP ${status})${detail ? ` — ${detail}` : ""}.`;
}

// Models are asked for JSON and usually comply, but not always cleanly: a
// code fence, a sentence of preamble, or a trailing comma will all break a
// bare JSON.parse. Recover what we reasonably can rather than throwing away
// an analysis that cost real money to produce.
// Models return valid JSON that is nonetheless missing keys — an empty
// section gets dropped, a nested object is flattened. The UI read chains
// like a.insights.negotiationLevers directly, so ONE missing key blanked
// the entire app with "Cannot read properties of undefined". This fills in
// the shape so a partial answer degrades to an empty section instead.
function normaliseAnalysis(a) {
  const o = (v) => (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  const arr = (v) => Array.isArray(v) ? v : [];
  const r = { ...o(a) };
  r.extracted     = o(r.extracted);
  r.dataPoints    = arr(r.dataPoints);
  r.risks         = arr(r.risks);
  r.opportunities = arr(r.opportunities);
  r.obligations   = arr(r.obligations);

  r.cost = o(r.cost);
  r.cost.lineItems = arr(r.cost.lineItems);
  r.cost.breakdown = arr(r.cost.breakdown);
  r.cost.summary = r.cost.summary ?? "";
  r.cost.estimatedAnnualSaving = r.cost.estimatedAnnualSaving ?? null;

  r.users = o(r.users);
  r.users.breakdown = arr(r.users.breakdown);
  r.users.points = arr(r.users.points);
  r.users.summary = r.users.summary ?? "";

  r.compliance = o(r.compliance);
  r.compliance.clauses    = arr(r.compliance.clauses);
  r.compliance.regulatory = arr(r.compliance.regulatory);
  r.compliance.summary    = r.compliance.summary ?? "";

  r.knowledge = o(r.knowledge);
  r.knowledge.points            = arr(r.knowledge.points);
  r.knowledge.verbalCommitments = arr(r.knowledge.verbalCommitments);
  r.knowledge.keyPeople         = arr(r.knowledge.keyPeople);
  r.knowledge.openQuestions     = arr(r.knowledge.openQuestions);
  // keyPersonRisk is rendered with .map in one place, so it must be an array
  // even though the prompt describes it loosely.
  r.knowledge.keyPersonRisk     = Array.isArray(r.knowledge.keyPersonRisk)
                                    ? r.knowledge.keyPersonRisk
                                    : (r.knowledge.keyPersonRisk ? [r.knowledge.keyPersonRisk] : []);
  r.knowledge.summary           = r.knowledge.summary ?? "";

  r.insights = o(r.insights);
  r.insights.negotiationLevers = arr(r.insights.negotiationLevers);
  r.insights.recommendations   = arr(r.insights.recommendations);
  r.insights.benchmarks        = arr(r.insights.benchmarks);
  r.insights.watchDates        = arr(r.insights.watchDates);
  r.insights.summary           = r.insights.summary ?? "";

  r.execSummary = r.execSummary ?? "";
  r.healthScore = Number.isFinite(r.healthScore) ? r.healthScore : null;
  r.riskGrade   = r.riskGrade ?? null;
  if (Array.isArray(a?.partial)) r.partial = a.partial;   // keep the honesty flag

  // Some fields are rendered directly as text. If the model returns objects
  // there instead, React throws error #31 and the whole page dies. Flatten
  // them to readable strings rather than letting a shape mismatch crash.
  const asText = (v) => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v !== "object") return String(v);
    const vals = Object.entries(v)
      .filter(([, x]) => x != null && x !== "")
      .map(([k, x]) => (k === "area" || k === "name" || k === "title") ? String(x) : String(x));
    return vals.join(" — ");
  };
  const textArr = (v) => (Array.isArray(v) ? v : []).map(asText).filter(Boolean);
  r.compliance.regulatory      = textArr(r.compliance.regulatory);
  r.knowledge.points           = textArr(r.knowledge.points);
  r.knowledge.keyPersonRisk    = textArr(r.knowledge.keyPersonRisk);
  r.knowledge.openQuestions    = textArr(r.knowledge.openQuestions);
  r.insights.negotiationLevers = textArr(r.insights.negotiationLevers);
  r.insights.recommendations   = textArr(r.insights.recommendations);
  r.insights.watchDates        = textArr(r.insights.watchDates);
  r.users.points               = textArr(r.users.points);

  // Belt and braces. SAMPLE_ANALYSIS is, by definition, the shape the UI
  // knows how to render — so mirror any array or object it has that the
  // model left out. Hand-listing fields missed three of them in a row.
  const mirror = (tmpl, target) => {
    for (const k of Object.keys(tmpl || {})) {
      const tv = tmpl[k];
      if (Array.isArray(tv)) {
        if (!Array.isArray(target[k])) target[k] = [];
      } else if (tv && typeof tv === "object") {
        if (!target[k] || typeof target[k] !== "object" || Array.isArray(target[k])) target[k] = {};
        mirror(tv, target[k]);
      }
    }
  };
  try { mirror(SAMPLE_ANALYSIS, r); } catch (e) { /* never block an analysis over this */ }
  return r;
}

// Parse one stage's JSON. Deliberately does NOT normalise — the stages are
// merged first, then normalised once, so an empty section from stage 2 is
// not mistaken for a complete one.
// A network drop, a cold start or a brief upstream wobble should not lose
// a stage that is otherwise fine. Retry transient failures with backoff;
// never retry something that will fail identically (a bad key, a rejected
// origin, an exhausted rate limit).
async function fetchWithRetry(url, opts, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, opts);
      // 5xx and 429 are worth another go; 4xx (except 429) will not change.
      if (res.status >= 500 || res.status === 408) {
        if (i < attempts - 1) { await new Promise((r) => setTimeout(r, 1200 * Math.pow(2, i))); continue; }
      }
      return res;
    } catch (e) {
      // "Failed to fetch" lands here: the request never got a response.
      lastErr = e;
      if (i < attempts - 1) { await new Promise((r) => setTimeout(r, 1200 * Math.pow(2, i))); continue; }
    }
  }
  throw new Error("Could not reach your AI function after three attempts. "
    + "That usually means a brief network problem — try again in a moment. "
    + "If it persists, check the function is still deployed in Supabase.");
}

function parseStageJson(raw) {
  let t = String(raw).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = t.indexOf("{");
  if (first > 0) t = t.slice(first);
  const last = t.lastIndexOf("}");
  if (last > 0 && last < t.length - 1) t = t.slice(0, last + 1);

  try { return JSON.parse(t); } catch (e) { /* keep going */ }
  // Trailing commas before a closing brace or bracket.
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); } catch (e) { /* keep going */ }

  // Salvage a truncated response. If the model stopped mid-array we can
  // still keep every complete entry before the cut, which is far better
  // than discarding a section that cost real money to produce.
  const salvaged = repairTruncatedJson(t);
  if (salvaged) return salvaged;

  throw new Error("the response was not valid JSON");
}

// Walk the string tracking depth and string state, cut back to the last
// point where the structure was sound, then close what is still open.
function repairTruncatedJson(t) {
  const stack = [];
  let inStr = false, esc = false, lastGood = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
    // A comma at depth 1 or 2 is a safe place to cut: the item before it
    // is complete.
    else if (c === "," && stack.length <= 3) lastGood = i;
  }
  if (lastGood < 0) return null;

  let head = t.slice(0, lastGood);
  // Recompute what is still open at the cut point and close it.
  const open = [];
  inStr = false; esc = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") open.push("}");
    else if (c === "[") open.push("]");
    else if (c === "}" || c === "]") open.pop();
  }
  if (inStr) head += '"';
  const closed = head + open.reverse().join("");
  try {
    const parsed = JSON.parse(closed);
    if (parsed && typeof parsed === "object") { parsed.__salvaged = true; return parsed; }
  } catch (e) { /* genuinely unrecoverable */ }
  return null;
}

function parseAnalysisJson(raw) {
  let t = String(raw).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first > 0 || (last > -1 && last < t.length - 1)) {
    if (first > -1 && last > first) t = t.slice(first, last + 1);
  }
  try { return normaliseAnalysis(JSON.parse(t)); } catch (e) { /* try harder below */ }
  // Trailing commas before a closing brace or bracket.
  try { return normaliseAnalysis(JSON.parse(t.replace(/,\s*([}\]])/g, "$1"))); } catch (e) { /* fall through */ }
  throw new Error("The AI's response was not valid JSON, so the analysis could not be read. "
    + "This is usually a one-off — running it again normally works.");
}

async function runAnalysis(contract, customPlaybook, policyPacks, onStage) {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 1600));
    const sample = normaliseAnalysis(JSON.parse(JSON.stringify(SAMPLE_ANALYSIS)));
    const own = {
      name: contract.name, category: contract.category,
      annualValue: contract.annualValue, currency: contract.currency,
      startDate: contract.startDate, endDate: contract.endDate,
      noticePeriodDays: contract.noticePeriodDays, autoRenew: contract.autoRenew,
      owner: contract.owner, users: contract.users,
    };
    sample.extracted = { ...sample.extracted };
    for (const [k, v] of Object.entries(own)) {
      if (v !== null && v !== undefined && v !== "") sample.extracted[k] = v;
    }
    sample.dataPoints = (sample.dataPoints || []).map((dp) =>
      own[dp.field] !== undefined && own[dp.field] !== null && own[dp.field] !== ""
        ? { ...dp, value: String(own[dp.field]) } : dp);
    if (!ED.crossClause) {
      sample.risks = sample.risks.filter((r) => !/cross|conflict|purchase order|rate card/i.test(r.title + r.detail));
    }
    return sample;
  }

  if (!AI_ENDPOINT) throw aiUnavailable();

  // One call per stage. Each asks for a slice small enough to finish
  // inside the token budget, so nothing gets cut off mid-JSON.
  // Five stages, each capped in the prompt AND given generous headroom.
  // The caps are what make this robust: they bound the output regardless
  // of how large or complex the contract is. The ceiling is only a
  // backstop for when a model ignores them.
  const stages = [
    { n: 1, label: "Reading the contract and extracting terms",   build: stage1Prompt, tokens: 8000 },
    { n: 2, label: "Assessing cost and usage",                    build: stage2Prompt, tokens: 8000 },
    { n: 3, label: "Identifying risks and savings",               build: stage3Prompt, tokens: 8000 },
    { n: 4, label: "Checking compliance and obligations",         build: stage4Prompt, tokens: 8000 },
    { n: 5, label: "Capturing knowledge and next steps",          build: stage5Prompt, tokens: 8000 },
  ];

  const merged = {};
  const failed = [];

  // One id for the whole five-stage run. The server reserves the ten
  // credits once against this id, lets the remaining stages through
  // free, and commits the charge only when the last stage returns — so
  // a run that fails at stage four costs nothing.
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  for (const st of stages) {
    if (onStage) onStage(st.n, stages.length, st.label);
    const lastStage = st.n === stages.length;
    try {
      const res = await fetchWithRetry(AI_ENDPOINT, {
        method: "POST",
        headers: aiHeaders(),
        body: JSON.stringify({
          kind: "analysis",
          contract_id: contract?.id,
          run_id: runId,
          final: lastStage,
          max_tokens: st.tokens,
          messages: [{ role: "user", content: st.build(contract, customPlaybook, policyPacks) }],
        }),
      });

      if (!res.ok) {
        let detail = "";
        try {
          const err = await res.json();
          detail = err?.error?.message || err?.error || err?.detail || "";
        } catch (e) { /* body was not JSON */ }
        throw new Error(explainAiFailure(res.status, String(detail)));
      }

      const data = await res.json();
      if (data?.stop_reason === "max_tokens") {
        // One retry, explicitly asking for half as much. A contract dense
        // enough to overflow an 8,000-token stage will still yield its
        // most material findings when told to be brief.
        const brief = st.build(contract, customPlaybook, policyPacks)
          + "\n\nIMPORTANT: your previous attempt was too long and was discarded. Return AT MOST HALF the number of items in every array, and keep every string to one short sentence.";
        const retry = await fetchWithRetry(AI_ENDPOINT, {
          method: "POST", headers: aiHeaders(),
          body: JSON.stringify({
            kind: "analysis", contract_id: contract?.id, run_id: runId, final: lastStage,
            max_tokens: st.tokens, messages: [{ role: "user", content: brief }],
          }),
        });
        if (!retry.ok) throw new Error(explainAiFailure(retry.status, ""));
        const rd = await retry.json();
        if (rd?.stop_reason === "max_tokens") {
          throw new Error(`this section is unusually large even when asked to be brief — try splitting the documents across two records.`);
        }
        const rt = (rd.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
        Object.assign(merged, parseStageJson(rt));
        continue;
      }
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (!text.trim()) throw new Error(`Stage ${st.n} returned an empty response.`);

      Object.assign(merged, parseStageJson(text));
    } catch (e) {
      // A stage that fails does not throw away the stages that worked.
      // Stage 1 is the exception: without the extracted record there is
      // nothing worth showing, so that one is fatal.
      failed.push({ stage: st.n, label: st.label, message: String(e?.message || e) });
      if (st.n === 1) throw e;
      console.error(`analysis stage ${st.n} failed`, e);
    }
  }

  const out = normaliseAnalysis(merged);
  if (failed.length) {
    out.partial = failed.map((f) => `Stage ${f.stage} (${f.label}) did not complete: ${f.message}`);
  }
  return out;
}

// ── Cedric ────────────────────────────────────────────────────
// SECURITY INVARIANT — account isolation:
// Cedric's context is built ONLY from the `contracts` state of the
// signed-in session, and (in production) that state is loaded through
// Supabase queries filtered by Row Level Security to the caller's own
// account. Never build Cedric context from a service-role query, a
// shared cache, or any source not scoped to the authenticated user.
// ── VOICE INPUT ───────────────────────────────────────────────
// Uses the browser's built-in Web Speech API. Two things worth knowing,
// and the UI says both:
//   1. Support is uneven. Chrome and Safari have it; Firefox does not.
//   2. In Chrome the audio is sent to Google for transcription. For a
//      product handling confidential contracts that is a real disclosure,
//      so this is off until the user presses the mic, and the warning is
//      shown the first time rather than buried in a policy.
function speechSupported() {
  return typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function makeRecogniser({ onText, onEnd, onError }) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = "en-GB";
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = (e) => {
    let finalText = "", interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t; else interim += t;
    }
    onText(finalText, interim);
  };
  r.onerror = (e) => onError(e?.error === "not-allowed"
    ? "Microphone access was blocked. Allow it in your browser's site settings."
    : e?.error === "no-speech" ? "I did not catch anything — try again."
    : "Voice input failed. You can still type your question.");
  r.onend = onEnd;
  return r;
}

async function askCedric(question, history, contract) {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 900));
    return `Good news — I've matched that to ${contract.ref} · ${contract.supplier}. This is the public demo build though, so my live AI engine is switched off to keep it free to host. In the full version I answer directly from this contract's ingested documents and analysis — renewal dates, saving opportunities, missing clauses, obligations due. Grab the full build to put me to work.`;
  }
  const scope = `The user has referenced this Contract Record, which is the ONLY contract you may discuss in this reply:\n${JSON.stringify({ ...contract, documents: undefined }, null, 2)}\n\nINGESTED DOCUMENTS:\n${clipContext(docContext(contract)) || "(none)"}\n\nLATEST ANALYSIS:\n${JSON.stringify(contract.analysis) || "(not yet run)"}`;

  if (!AI_ENDPOINT) throw aiUnavailable();
  const res = await fetchWithRetry(AI_ENDPOINT, {
    method: "POST",
    headers: aiHeaders(),
    body: JSON.stringify({
      kind: "cedric",
      contract_id: contract?.id,
      max_tokens: 1000,
      system: `You are Cedric, ContractIQ's contract intelligence assistant. Answer questions about the referenced contract using ONLY the data provided below. Be concise, commercially sharp and friendly — short paragraphs, plain language, currency-formatted figures. Some sources are MEETING TRANSCRIPTS: when you answer from one, say who said it and in which meeting, and be clear that it is something said rather than a contractual term. If the data doesn't contain the answer, say so and suggest which document to ingest. If the user asks about a different contract, tell them to name it by ref, name or supplier. Never invent contract terms.\n\n${scope}`,
      messages: [...history.map((m) => ({ role: m.role, content: m.text })), { role: "user", content: question }],
    }),
  });
  if (!res.ok) {
    // 402 (out of credits) and 429 (hourly limit) carry a sentence written
    // for the customer. Show that, rather than a status code they cannot act on.
    let msg = "";
    try { const err = await res.json(); msg = err?.error || ""; } catch (e) { /* not JSON */ }
    throw new Error(msg || explainAiFailure(res.status, ""));
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "Sorry — I couldn't process that. Try again.";
}

// ── Exports (unchanged Word/PDF/PPT outline) ──────────────────
function buildReportHTML(ct) {
  const a = ct.analysis;
  const li = (arr, f) => (arr || []).map(f).join("");
  return `
  <html><head><meta charset="utf-8"><title>ContractIQ — ${esc(ct.ref)}</title>
  <style>
    body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:40px auto;line-height:1.55;padding:0 24px;}
    h1{font-size:28px;letter-spacing:-0.02em;} h2{font-size:18px;margin-top:28px;border-bottom:2px solid #cfe6ff;padding-bottom:6px;color:#0058b0;}
    .sub{color:#6e6e73;} .tag{font-weight:bold;color:#1d7a3a;} table{width:100%;border-collapse:collapse;margin-top:10px;}
    td,th{border:1px solid #d5e7fa;padding:8px 10px;font-size:13px;text-align:left;} th{background:#f0f7ff;}
  </style></head><body>
  <p style="font-size:12px;letter-spacing:2px;color:#0071e3;font-weight:bold;">CONTRACT<span style="color:#1d1d1f;">IQ</span> INSIGHT REPORT</p>
  <h1>${esc(ct.name || ct.ref)} — ${esc(ct.supplier)}</h1>
  <p class="sub">Ref ${esc(ct.ref)} · ${esc(ct.category || "—")} · ${fmtMoney(ct.annualValue, ct.currency)}/yr · Term ${ct.startDate || "—"} → ${ct.endDate || "—"} · Owner: ${esc(ct.owner || "—")} · Generated ${new Date().toLocaleDateString("en-GB")}</p>
  <h2>Executive summary</h2><p>${esc(a.execSummary)}</p>
  <p><b>Commercial health score:</b> ${a.healthScore}/100 &nbsp;·&nbsp; <span class="tag">Est. annual saving opportunity: ${fmtMoney(a.cost.estimatedAnnualSaving, ct.currency)}</span></p>
  <h2>Cost</h2><p>${esc(a.cost.summary)}</p>
  <table><tr><th>Element</th><th>Detail</th></tr>${li(a.cost.breakdown, (b) => `<tr><td>${esc(b.label)}</td><td>${esc(b.detail)}</td></tr>`)}</table>
  <h2>Users</h2><p>${esc(a.users.summary)}</p><ul>${li(a.users.points, (p) => `<li>${esc(p)}</li>`)}</ul>
  <h2>Risks</h2><table><tr><th>Risk</th><th>Severity</th><th>Detail</th></tr>${li(a.risks, (r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.severity)}</td><td>${esc(r.detail)}</td></tr>`)}</table>
  <h2>Opportunities</h2><table><tr><th>Opportunity</th><th>Est. saving</th><th>How to realise</th></tr>${li(a.opportunities, (o) => `<tr><td>${esc(o.title)}</td><td>${esc(o.savingEstimate)}</td><td>${esc(o.detail)}</td></tr>`)}</table>
  <h2>Legal & compliance review</h2>
  ${a.compliance ? `<p>${esc(a.compliance.summary)}</p>
  <table><tr><th>Clause</th><th>Status</th><th>Note</th></tr>${li(a.compliance.clauses, (c) => `<tr><td>${esc(c.clause)}</td><td>${esc(c.status)}</td><td>${esc(c.note)}</td></tr>`)}</table>
  ${a.compliance.regulatory?.length ? `<p><b>Regulatory considerations</b></p><ul>${li(a.compliance.regulatory, (x) => `<li>${esc(x)}</li>`)}</ul>` : ""}
  ${a.obligations?.length ? `<p><b>Obligations register</b></p><table><tr><th>Obligation</th><th>Owner</th><th>Due</th><th>Note</th></tr>${li(a.obligations, (o) => `<tr><td>${esc(o.obligation)}</td><td>${o.owner === "us" ? "Ours" : "Supplier"}</td><td>${esc(o.due)}</td><td>${esc(o.note)}</td></tr>`)}</table>` : ""}
  <p style="font-size:11px;color:#86868b;">AI-generated screening aid — not legal advice. Confirm positions with qualified counsel.</p>` : "<p>Not assessed.</p>"}
  ${a.knowledge ? `<h2>Institutional knowledge (from meetings)</h2>
  <p>${esc(a.knowledge.summary)}</p>
  ${a.knowledge.points?.length ? `<table><tr><th>What we now know</th><th>Source</th><th>Why it matters</th></tr>${li(a.knowledge.points, (k) => `<tr><td>${esc(k.insight)}</td><td>${esc(k.source)}</td><td>${esc(k.matters)}</td></tr>`)}</table>` : ""}
  ${a.knowledge.verbalCommitments?.length ? `<p><b>Verbal commitments vs the written contract</b></p><table><tr><th>Commitment</th><th>Said by</th><th>In contract?</th><th>Action</th></tr>${li(a.knowledge.verbalCommitments, (v) => `<tr><td>${esc(v.commitment)}</td><td>${esc(v.saidBy)}</td><td>${esc(v.inContract)}</td><td>${esc(v.action)}</td></tr>`)}</table>` : ""}
  ${a.knowledge.keyPersonRisk?.length ? `<p><b>Knowledge at risk of loss</b></p><ul>${li(a.knowledge.keyPersonRisk, (x) => `<li>${esc(x)}</li>`)}</ul>` : ""}
  ${a.knowledge.openQuestions?.length ? `<p><b>Questions to ask while people are still available</b></p><ul>${li(a.knowledge.openQuestions, (x) => `<li>${esc(x)}</li>`)}</ul>` : ""}
  <p style="font-size:11px;color:#86868b;">Meeting content is reported context, not contractual terms.</p>` : ""}
  <h2>Insights & negotiation levers</h2>
  <p><b>Negotiation levers</b></p><ul>${li(a.insights.negotiationLevers, (x) => `<li>${esc(x)}</li>`)}</ul>
  <p><b>Recommendations</b></p><ul>${li(a.insights.recommendations, (x) => `<li>${esc(x)}</li>`)}</ul>
  <p><b>Dates to watch</b></p><ul>${li(a.insights.watchDates, (x) => `<li>${esc(x)}</li>`)}</ul>
  </body></html>`;
}

function exportWord(ct) {
  const blob = new Blob(["﻿" + buildReportHTML(ct)], { type: "application/msword" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ContractIQ_${ct.ref}_${ct.supplier}.doc`.replace(/\s+/g, "_");
  a.click();
}
function exportPDF(ct) {
  const w = window.open("", "_blank");
  w.document.write(buildReportHTML(ct));
  w.document.close();
  setTimeout(() => w.print(), 400);
}

function exportPPT(ct) {
  const a = ct.analysis;
  const slides = [
    `SLIDE 1 — ${ct.name || ct.ref} · ${ct.supplier}\nContractIQ Insight Pack · ${new Date().toLocaleDateString("en-GB")}\n${fmtMoney(ct.annualValue, ct.currency)}/yr · Health score ${a.healthScore}/100${a.riskGrade ? ` · Risk Grade ${a.riskGrade}` : ""}`,
    `SLIDE 2 — Executive summary\n${a.execSummary}`,
    `SLIDE 3 — Cost position\n${a.cost.summary}\nEstimated annual saving: ${fmtMoney(a.cost.estimatedAnnualSaving, ct.currency)}`,
    `SLIDE 4 — Users\n${a.users.points.map((p) => "• " + p).join("\n")}`,
    `SLIDE 5 — Risks\n${a.risks.map((r) => `• [${r.severity.toUpperCase()}] ${r.title}`).join("\n")}`,
    `SLIDE 6 — Legal & compliance\n${a.compliance ? a.compliance.clauses.map((c) => `• [${c.status.toUpperCase()}] ${c.clause}`).join("\n") : "Not assessed."}`,
    `SLIDE 7 — Institutional knowledge\n${a.knowledge ? (a.knowledge.points || []).map((k) => `• ${k.insight} (${k.source})`).join("\n") || a.knowledge.summary : "No transcripts ingested."}`,
    `SLIDE 8 — Opportunities\n${a.opportunities.map((o) => `• ${o.title} (${o.savingEstimate})`).join("\n")}`,
    `SLIDE 9 — Negotiation levers & next steps\n${a.insights.negotiationLevers.map((x) => "• " + x).join("\n")}\n\nRecommendations:\n${a.insights.recommendations.map((x) => "• " + x).join("\n")}`,
  ].join("\n\n────────────────────────\n\n");
  const blob = new Blob([slides], { type: "text/plain" });
  const el = document.createElement("a");
  el.href = URL.createObjectURL(blob);
  el.download = `ContractIQ_${ct.ref}_slides.txt`.replace(/\s+/g, "_");
  el.click();
}

// ── Renewal alerts: calendar reminders (.ics) ─────────────────
// Two events, not one. The notice deadline is the date you must act BY;
// the review start is when work has to begin for that date to be
// achievable. A reminder on the deadline itself is already too late —
// which is exactly how a notice window gets missed while someone is on
// annual leave.
function icsEscape(t) {
  return String(t ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
    .replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsEventsFor(ct) {
  if (!ct.endDate) return [];
  const end = new Date(ct.endDate);
  if (isNaN(end)) return [];
  const days = ct.noticePeriodDays || 90;
  const notice = new Date(end.getTime() - days * 86400000);
  // Lead time to actually do the work: benchmark, gather stakeholders,
  // negotiate. Taken from the analysis where the AI has estimated it,
  // otherwise a sensible default of twelve weeks.
  const weeks = Number(ct.analysis?.insights?.reviewLeadTimeWeeks) || 12;
  const stated = ct.analysis?.insights?.reviewStartDate;
  const review = stated && !isNaN(new Date(stated))
    ? new Date(stated)
    : new Date(notice.getTime() - weeks * 7 * 86400000);

  const day = (d) => d.toISOString().split("T")[0].replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const ev = [];

  // All-day events, because a deadline is a date and not a moment.
  ev.push([
    "BEGIN:VEVENT",
    `UID:${ct.id}-notice@contractiq`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${day(notice)}`,
    `DTEND;VALUE=DATE:${day(new Date(notice.getTime() + 86400000))}`,
    `SUMMARY:${icsEscape(`NOTICE DEADLINE — ${ct.ref} ${ct.supplier}`)}`,
    `DESCRIPTION:${icsEscape(
      `Last day to serve notice on ${ct.name || ct.ref}.\n\n` +
      `Term ends ${ct.endDate}. Notice period ${days} days.` +
      (ct.autoRenew ? `\n\nThis contract AUTO-RENEWS if notice is not served.` : "") +
      `\n\nRaised by ContractIQ.`)}`,
    "TRANSP:TRANSPARENT",
    // Three warnings, not one. Ninety days out is when a review still has
    // room to change the outcome.
    "BEGIN:VALARM", "TRIGGER:-P90D", "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(`90 days to notice deadline — ${ct.ref}`)}`, "END:VALARM",
    "BEGIN:VALARM", "TRIGGER:-P30D", "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(`30 days to notice deadline — ${ct.ref}`)}`, "END:VALARM",
    "BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(`ONE WEEK to notice deadline — ${ct.ref}`)}`, "END:VALARM",
    "END:VEVENT",
  ].join("\r\n"));

  ev.push([
    "BEGIN:VEVENT",
    `UID:${ct.id}-review@contractiq`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${day(review)}`,
    `DTEND;VALUE=DATE:${day(new Date(review.getTime() + 86400000))}`,
    `SUMMARY:${icsEscape(`Start renewal review — ${ct.ref} ${ct.supplier}`)}`,
    `DESCRIPTION:${icsEscape(
      `Begin the renewal review now to be ready for the notice deadline on ` +
      `${notice.toISOString().split("T")[0]}.\n\n` +
      `Benchmark the rates, gather the stakeholders, and decide the position ` +
      `before you have to serve notice.\n\nRaised by ContractIQ.`)}`,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(`Renewal review for ${ct.ref} starts next week`)}`, "END:VALARM",
    "END:VEVENT",
  ].join("\r\n"));

  return ev;
}

function downloadICS(events, filename) {
  if (!events.length) return false;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ContractIQ//Renewals//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events, "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  a.download = filename.replace(/\s+/g, "_");
  a.click();
  return true;
}

function exportICS(ct) {
  return downloadICS(icsEventsFor(ct), `${ct.ref}_renewal_reminders.ics`);
}

// Every renewal in the portfolio, in one file. Import once and the whole
// estate is in the calendar with warnings on each.
function exportAllRenewals(contracts) {
  const events = contracts.flatMap((c) => icsEventsFor(c));
  return downloadICS(events, `ContractIQ_all_renewals_${new Date().toISOString().split("T")[0]}.ics`);
}

// ── Executive digest: one-page portfolio summary ──────────────
function exportDigest(contracts) {
  const withA = contracts.filter((c) => c.analysis);
  const due = contracts.filter((c) => daysTo(c.endDate) != null && daysTo(c.endDate) >= 0 && daysTo(c.endDate) <= 180)
    .sort((a, b) => daysTo(a.endDate) - daysTo(b.endDate));
  const highRisks = withA.flatMap((c) => (c.analysis.risks || []).filter((r) => r.severity === "high").map((r) => ({ c, r })));
  const opps = withA.flatMap((c) => (c.analysis.opportunities || []).map((o) => ({ c, o })));
  const realised = opps.filter((x) => x.o.realised);
  const totalValue = contracts.reduce((s, c) => s + (c.annualValue || 0), 0);
  const totalSaving = withA.reduce((s, c) => s + (c.analysis?.cost?.estimatedAnnualSaving || 0), 0);
  const html = `<html><head><meta charset="utf-8"><title>ContractIQ Executive Digest</title>
  <style>body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:36px auto;line-height:1.5;padding:0 24px;}
  h1{font-size:24px;letter-spacing:-0.02em;} h2{font-size:15px;margin-top:22px;color:#0058b0;border-bottom:2px solid #cfe6ff;padding-bottom:4px;}
  .sub{color:#6e6e73;font-size:13px;} table{width:100%;border-collapse:collapse;margin-top:8px;} td,th{border:1px solid #d5e7fa;padding:6px 9px;font-size:12.5px;text-align:left;} th{background:#f0f7ff;}
  .big{font-size:20px;font-weight:bold;}</style></head><body>
  <p style="font-size:11px;letter-spacing:2px;color:#0071e3;font-weight:bold;">CONTRACTIQ EXECUTIVE DIGEST</p>
  <h1>Portfolio position — ${new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h1>
  <p class="sub">${contracts.length} contracts · Generated ${new Date().toLocaleDateString("en-GB")}</p>
  <table><tr><th>Annual portfolio value</th><th>Savings identified</th><th>Opportunities realised</th><th>Renewals in 180 days</th><th>High risks open</th></tr>
  <tr><td class="big">${fmtMoney(totalValue)}</td><td class="big" style="color:#1d7a3a">${fmtMoney(totalSaving)}</td><td class="big">${realised.length} of ${opps.length}</td><td class="big">${due.length}</td><td class="big" style="color:${highRisks.length ? "#c0271d" : "#1d1d1f"}">${highRisks.length}</td></tr></table>
  <h2>Decisions needed — renewals inside 180 days</h2>
  ${due.length ? `<table><tr><th>Ref</th><th>Supplier</th><th>Annual value</th><th>Days to end</th><th>Notice period</th><th>Auto-renew</th></tr>
  ${due.map((c) => `<tr><td>${esc(c.ref)}</td><td>${esc(c.supplier)}</td><td>${fmtMoney(c.annualValue, c.currency)}</td><td>${daysTo(c.endDate)}</td><td>${c.noticePeriodDays || "—"} days</td><td>${c.autoRenew ? "YES" : "No"}</td></tr>`).join("")}</table>` : "<p>None in the window.</p>"}
  <h2>High risks requiring attention</h2>
  ${highRisks.length ? `<table><tr><th>Contract</th><th>Risk</th></tr>${highRisks.map(({ c, r }) => `<tr><td>${esc(c.ref)} · ${esc(c.supplier)}</td><td><b>${esc(r.title)}</b> — ${esc(r.detail)}</td></tr>`).join("")}</table>` : "<p>No high-severity risks flagged.</p>"}
  <h2>Savings pipeline</h2>
  ${opps.length ? `<table><tr><th>Contract</th><th>Opportunity</th><th>Estimate</th><th>Status</th></tr>${opps.map(({ c, o }) => `<tr><td>${esc(c.ref)}</td><td>${esc(o.title)}</td><td>${esc(o.savingEstimate)}</td><td>${o.realised ? "REALISED" : "Identified"}</td></tr>`).join("")}</table>` : "<p>Run analyses to build the savings pipeline.</p>"}
  <p style="font-size:10px;color:#86868b;margin-top:18px;">AI-generated screening summary — not legal advice. Verify positions against original contract text.</p>
  </body></html>`;
  const blob = new Blob(["﻿" + html], { type: "application/msword" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ContractIQ_Executive_Digest_${new Date().toISOString().slice(0, 7)}.doc`;
  a.click();
}

// ── Supabase (REST) ───────────────────────────────────────────
async function supabasePush(cfg, contracts) {
  const rows = contracts.map((c) => ({
    id: c.id, ref: c.ref, name: c.name, supplier: c.supplier, category: c.category,
    annual_value: c.annualValue, currency: c.currency, start_date: c.startDate || null,
    end_date: c.endDate || null, notice_period_days: c.noticePeriodDays, auto_renew: c.autoRenew,
    owner: c.owner, users_count: c.users, notes: c.notes,
    analysis: c.analysis, documents_meta: c.documents.map(({ text, ...m }) => m),
  }));
  const res = await fetch(`${cfg.url}/rest/v1/contracts`, {
    method: "POST",
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
async function supabasePull(cfg) {
  const res = await fetch(`${cfg.url}/rest/v1/contracts?select=*`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    id: r.id, ref: r.ref, name: r.name, supplier: r.supplier, category: r.category,
    annualValue: r.annual_value, currency: r.currency, startDate: r.start_date,
    endDate: r.end_date, noticePeriodDays: r.notice_period_days, autoRenew: r.auto_renew,
    owner: r.owner, users: r.users_count, notes: r.notes,
    analysis: r.analysis, documents: r.documents_meta || [],
  }));
}

const TABS = ["Overview", "Verify", "Cost", "Users", "Risk", "Opportunities", "Compliance", "Knowledge", "Insights", "Documents"];

// ─────────────────────────────────────────────────────────────
// ── In-app legal viewer (Terms / Privacy / DPA) ──────────────
// Full canonical versions live on the website; these summaries let a user
// read the essentials before accepting. The acceptance checkbox at sign-in
// is affirmative consent to all three.
const LEGAL = {
  terms: {
    title: "Terms of Use",
    updated: "Version 3.0 · 25 July 2026",
    body: [
      ["Not legal advice", "ContractIQ is a software tool that produces automated analysis for information and triage only. It is not a law firm and does not provide legal, financial or professional advice. Output is generated by AI, is probabilistic, can be wrong or incomplete, and must be independently verified by you — and, where significant, by a qualified lawyer — before you rely on it. No lawyer–client relationship is created."],
      ["Output is information only", "Output may contain errors, omissions or hallucinations and may vary between runs. You must not rely on it as the sole basis for any decision. Any reliance is at your own risk."],
      ["Your verification responsibility", "You are solely responsible for checking all Output against the original documents and for obtaining professional advice on anything significant. \"The tool said so\" is not a defence."],
      ["Meeting recordings & transcripts", "You must not upload a transcript unless your organisation had a lawful basis to record it and informed all participants in advance (as with Microsoft Teams). By uploading, you warrant you were entitled to, and you indemnify us against claims arising from content you were not entitled to upload."],
      ["Your content", "You keep ownership of everything you upload. We process it only to provide the Services, and we never use it to train AI models."],
      ["Liability", "We do not exclude liability for death or personal injury from negligence, or for fraud. Otherwise, and to the maximum extent lawful, we are not liable for reliance on Output or for indirect or consequential loss, and our total liability is capped at the greater of the fees you paid in the last 12 months or £100."],
      ["Governing law", "England and Wales for business users; consumers keep the mandatory protections of their home country."],
    ],
  },
  privacy: {
    title: "Privacy Policy",
    updated: "Version 2.0 · 25 July 2026",
    body: [
      ["Who controls your data", "For your account data, we are the controller. For the personal data inside documents and transcripts you upload, you are the controller and we are your processor under the DPA."],
      ["What we collect", "Account and billing details, the Customer Content you upload, usage and device data, and support communications."],
      ["How we use it", "To provide, secure, meter and improve the Services. We do not use Customer Content to train AI models, and we do not sell your personal data."],
      ["Storage & protection", "Encryption in transit, database-enforced separation between accounts, and an optional Zero-Retention mode that expunges document and transcript text right after analysis."],
      ["International transfers", "Where data leaves the UK/EEA we use approved safeguards (UK IDTA/Addendum, EU Standard Contractual Clauses, and DPF-certified US providers where applicable)."],
      ["Your rights", "Access, correction, deletion, restriction, objection, portability and consent withdrawal — with regional supplements for the UK, EU, US states, Canada, India and South Africa."],
      ["Contact", "privacy@yourdomain.com"],
    ],
  },
  dpa: {
    title: "Data Processing Agreement",
    updated: "For Business customers · Version 1.0 · 25 July 2026",
    body: [
      ["Roles", "You are the controller and ContractIQ is the processor for the personal data in your uploaded content. We process it only on your documented instructions."],
      ["Meeting transcripts", "You warrant that, for every recording uploaded, you had a lawful basis and gave participants the recording notice required by law (equivalent to the Microsoft Teams notice). We are not responsible for your compliance with those obligations."],
      ["Security & subprocessors", "Appropriate technical and organisational measures; subprocessors (hosting, AI model provider, payments, email) are bound by equivalent obligations and we remain liable for them."],
      ["Breach notification", "We notify you without undue delay and within 72 hours of becoming aware of a personal-data breach affecting your data."],
      ["Return & deletion", "On termination we delete or return your data; you have 30 days to export first."],
    ],
  },
};

function LegalModal({ view, onClose }) {
  const doc = LEGAL[view] || LEGAL.terms;
  const tabs = [["terms", "Terms"], ["privacy", "Privacy"], ["dpa", "DPA"]];
  const [tab, setTab] = useState(view);
  const active = LEGAL[tab];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(8,22,39,0.6)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 10, borderTop: "3px solid #2F7BD9", width: 620, maxWidth: "100%", maxHeight: "84vh", display: "flex", flexDirection: "column", boxShadow: "0 30px 80px rgba(4,14,28,0.5)" }}>
        <div style={{ display: "flex", gap: 6, padding: "16px 20px 0", borderBottom: "1px solid #E1EAF6" }}>
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{ border: "none", background: "none", cursor: "pointer", padding: "8px 14px", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: tab === k ? "#2F7BD9" : "#62748B", borderBottom: tab === k ? "2px solid #2F7BD9" : "2px solid transparent" }}>{label}</button>
          ))}
          <button onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", fontSize: 20, color: "#62748B", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "20px 24px", overflowY: "auto" }}>
          <h2 style={{ fontSize: 21, fontWeight: 700, color: "#0B1D33", margin: 0 }}>{active.title}</h2>
          <div style={{ fontSize: 12, color: "#86868b", margin: "4px 0 18px" }}>{active.updated}</div>
          {active.body.map(([h, p], i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#16283E", marginBottom: 3 }}>{h}</div>
              <div style={{ fontSize: 13, color: "#3D4F66", lineHeight: 1.55 }}>{p}</div>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: "#86868b", marginTop: 8, paddingTop: 12, borderTop: "1px solid #E1EAF6", lineHeight: 1.5 }}>Summary for in-app reference. The full and canonical versions live in the Legal Centre and prevail over anything summarised here. ContractIQ is an automated screening aid, not legal advice.<div style={{ marginTop: 8 }}><a href="../legal.html" target="_blank" rel="noopener" style={{ color: "#2F7BD9", fontWeight: 600 }}>Open the full Legal Centre</a> &middot; CodeIQ Holdings Ltd, company 17454743</div></div>
        </div>
      </div>
    </div>
  );
}

// Password field with a show/hide toggle.
//
// This MUST live at module level. Defined inside the component body it is
// a new function identity on every render, so React treats it as a
// different component type, unmounts the <input> and mounts a fresh one —
// which drops focus after every keystroke and makes the field feel like
// it only accepts one character. Visibility is passed in rather than read
// from the parent's state so the component stays pure.
function PasswordField({ label, value, onChange, placeholder, autoComplete, onEnter, shown, onToggle }) {
  return (
    <div className="fld">
      <label>{label}</label>
      <div style={{ position: "relative" }}>
        <input type={shown ? "text" : "password"} value={value} onChange={onChange}
          placeholder={placeholder} autoComplete={autoComplete}
          onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
          style={{ paddingRight: 44, width: "100%", boxSizing: "border-box" }} />
        <button type="button" onClick={onToggle}
          aria-label={shown ? "Hide password" : "Show password"}
          title={shown ? "Hide password" : "Show password"}
          style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", cursor: "pointer", padding: 6,
            display: "flex", alignItems: "center", color: shown ? "#2F7BD9" : "#8FA3BC" }}>
          {shown ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.15 18.15 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.39-1.61" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><path d="m2 2 20 20" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" /><circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export default function ContractIQ() {
  const [accountUsers, setAccountUsers] = useState(seedUsers);
  const [currentUser, setCurrentUser] = useState(null);
  const [settingsLegal, setSettingsLegal] = useState(null);   // in-app legal viewer from Settings
  const [policyPacks, setPolicyPacks] = useState(DEFAULT_POLICY_PACKS);  // hot-swappable compliance rules
  // Transcript consent: recorded once per account, with who and when, and
  // referenced by every transcript ingested afterwards. This is the evidence
  // trail that the recording-notice obligation in clause 7 was acknowledged.
  const [transcriptConsent, setTranscriptConsent] = useState(null);  // { acceptedBy, acceptedAt, version }
  const [consentPrompt, setConsentPrompt] = useState(null);          // { files, transcriptNames }
  const [consentTicked, setConsentTicked] = useState(false);
  // Raw files held in memory for the session so a scanned document can be
  // OCR'd on demand without asking the user to upload it again.
  const fileCache = useRef(new Map());
  const [ocrBusy, setOcrBusy] = useState(null);   // { docId, page, total }
  const [search, setSearch] = useState("");                 // portfolio-wide search
  const searchRef = useRef(null);
  const [obligationTracking, setObligationTracking] = useState({});  // key -> {assignee,status,dueDate,completedAt}
  const [selectedIds, setSelectedIds] = useState([]);        // bulk-analysis selection
  const [bulkRun, setBulkRun] = useState(null);              // { done, total, current, results }
  const [auditTrail, setAuditTrail] = useState([]);   // { ts, user, contractId, field, action, from, to }
  const [telemetry, setTelemetry] = useState([]);     // { ts, op, ms, ok, contractId }
  const [login, setLogin] = useState({ username: "", password: "" });
  const [loginErr, setLoginErr] = useState(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // ── Real authentication ──
  // authView drives the screen: signin | signup | verify | forgot.
  // "verify" is where people spend longest, so it gets the most care.
  const [authView, setAuthView] = useState("signin");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMsg, setAuthMsg] = useState(null);
  const [authForm, setAuthForm] = useState({ email: "", password: "", fullName: "", company: "" });
  const [pendingEmail, setPendingEmail] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [session, setSession] = useState(null);
  const [useDemoAuth, setUseDemoAuth] = useState(false);
  // ── Async processing ──
  // With Supabase connected, analysis is queued rather than run in the
  // browser, so closing the tab no longer loses the work.
  const [asyncMode, setAsyncMode] = useState(true);
  const [activeJobs, setActiveJobs] = useState([]);
  const [accountId, setAccountId] = useState(null);
  // What the DATABASE says this account is entitled to. Null until it has
  // been read, at which point the app is running on the sandbox fallback.
  const [entitlement, setEntitlement] = useState(null);
  const [entitlementError, setEntitlementError] = useState(null);
  const [topupBusy, setTopupBusy] = useState(false);
  const [creditBlock, setCreditBlock] = useState(null);  // { title, message, canBuy }
  const [legalView, setLegalView] = useState(null);   // null | "terms" | "privacy" | "dpa"

  const [contracts, setContracts] = useState(seedContracts);
  const [selectedId, setSelectedId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [page, setPage] = useState("portfolio"); // portfolio | capabilities | pricing | trust | terms
  const [playbook, setPlaybook] = useState("");
  const [zeroRetention, setZeroRetention] = useState(false);
  const [ledger, setLedger] = useState([]);   // { ts, kind, credits, contractId } — every AI action
  const [apiKey, setApiKey] = useState(null);      // Enterprise: dedicated API access key
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [tab, setTab] = useState("Overview");
  const [analyzing, setAnalyzing] = useState(false);
  const [toast, setToast] = useState(null);
  // Seeded from the deployment config above, so a customer never has to
  // know what Supabase is. Settings can still override it for testing.
  const [sb, setSb] = useState({ url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY });
  const [newUser, setNewUser] = useState({ username: "", password: "", displayName: "" });
  const fileRef = useRef(null);
  const csvRef = useRef(null);

  // ── CSV bulk import: ref,supplier,name,annual_value,currency,start_date,end_date,notice_days,users ──
  const onImportCSV = async (file) => {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const header = lines[0].toLowerCase().split(",").map((h) => h.trim().replace(/['"]/g, ""));
      const col = (names) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const iRef = col(["ref", "id", "number"]), iSup = col(["supplier", "vendor"]), iName = col(["name", "title", "contract"]),
        iVal = col(["value", "cost", "spend"]), iCur = col(["currency"]), iStart = col(["start"]), iEnd = col(["end", "expiry", "expiration"]),
        iNotice = col(["notice"]), iUsers = col(["user", "seat", "licence", "license"]);
      if (iSup < 0) return notify("CSV needs at least a supplier column");
      const recs = lines.slice(1).map((line, n) => {
        const c = line.split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""));
        if (!c[iSup]) return null;
        return {
          id: "c" + Date.now() + n, ref: (iRef >= 0 && c[iRef]) || `CTR-${String(contracts.length + n + 1).padStart(4, "0")}`,
          supplier: c[iSup], name: (iName >= 0 && c[iName]) || null, category: null,
          annualValue: iVal >= 0 ? Number(String(c[iVal]).replace(/[^0-9.]/g, "")) || null : null,
          currency: (iCur >= 0 && c[iCur]) || "GBP",
          startDate: (iStart >= 0 && c[iStart]) || null, endDate: (iEnd >= 0 && c[iEnd]) || null,
          noticePeriodDays: iNotice >= 0 ? Number(c[iNotice]) || null : null, autoRenew: null,
          owner: null, users: iUsers >= 0 ? Number(c[iUsers]) || null : null, notes: "",
          documents: [], analysis: null, createdBy: currentUser?.displayName,
        };
      }).filter(Boolean);
      if (!recs.length) return notify("No importable rows found in that CSV");
      setContracts((cs) => [...cs, ...recs]);
      notify(`Imported ${recs.length} Contract Records from CSV`);
    } catch (e) { notify("CSV import failed — check the file format"); console.error(e); }
  };

  // Cedric state
  const [cedricOpen, setCedricOpen] = useState(false);
  const [cedricMsgs, setCedricMsgs] = useState([]);
  const [cedricInput, setCedricInput] = useState("");
  const [pendingAction, setPendingAction] = useState(null);   // question waiting for a contract
  const [glossaryQuery, setGlossaryQuery] = useState("");
  const [timelineFor, setTimelineFor] = useState(null);      // supplier key
  const [confFilter, setConfFilter] = useState("all");        // all | low | unverified
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState(null);
  const [voiceAccepted, setVoiceAccepted] = useState(false);
  const recogRef = useRef(null);
  const [actionCat, setActionCat] = useState("All");     // Ask Cedric actions filter
  const [actionSearch, setActionSearch] = useState("");
  const [copiedAction, setCopiedAction] = useState(null);
  const [navOpen, setNavOpen] = useState(false);   // burger menu
  const navMenuRef = useRef(null);
  const [intelOpen, setIntelOpen] = useState(false);   // Intelligence dropdown
  const intelRef = useRef(null);
  const [pwShown, setPwShown] = useState({});      // password visibility per field
  // Analysis takes 30-60 seconds on a real contract. A frozen button for a
  // minute reads as "broken", so show what stage it is at. The percentages
  // are an honest estimate of elapsed progress, not a measured figure —
  // the model does not report how far through it is.
  const [analysisStage, setAnalysisStage] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);  // 6-digit email code
  const [otpErr, setOtpErr] = useState(false);
  const [cedricBusy, setCedricBusy] = useState(false);
  const cedricEnd = useRef(null);
  useEffect(() => { cedricEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [cedricMsgs, cedricBusy]);

  // New record form (declared here — hooks must precede the login early-return)
  const [form, setForm] = useState({ ref: "", supplier: "" });

  const notify = (m) => { setToast(m); setTimeout(() => setToast(null), 3200); };
  const selected = contracts.find((c) => c.id === selectedId);
  const update = (id, patch) => setContracts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const totals = {
    value: contracts.reduce((s, c) => s + (c.annualValue || 0), 0),
    renewing: contracts.filter((c) => daysTo(c.endDate) != null && daysTo(c.endDate) >= 0 && daysTo(c.endDate) <= 180).length,
    savings: contracts.reduce((s, c) => s + (c.analysis?.cost?.estimatedAnnualSaving || 0), 0),
    risks: contracts.reduce((s, c) => s + (c.analysis?.risks?.filter((r) => r.severity === "high").length || 0), 0),
  };

  // ── Authentication actions ──
  const authGuard = async () => {
    if (!sb.url || !sb.key) {
      setAuthMsg({ kind: "err", text: "Add your Supabase project URL and anon key in Settings first — or use the demo sign-in." });
      return null;
    }
    try { return await getSb(sb.url, sb.key); }
    catch (e) { setAuthMsg({ kind: "err", text: friendlyAuthError(e.message) }); return null; }
  };

  const doSignUp = async () => {
    if (!acceptedTerms) return setAuthMsg({ kind: "err", text: "Please accept the Terms, Privacy Policy and DPA to create an account." });
    const { email, password, fullName, company } = authForm;
    if (!email.trim() || !password) return setAuthMsg({ kind: "err", text: "Enter your email address and a password." });
    if (password.length < 8) return setAuthMsg({ kind: "err", text: "Your password needs to be at least 8 characters." });
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true); setAuthMsg(null);
    const { data, error } = await client.auth.signUp({
      email: email.trim(), password,
      options: {
        emailRedirectTo: authRedirectUrl(),
        data: { full_name: fullName.trim() || null, company: company.trim() || null },
      },
    });
    setAuthBusy(false);
    if (error) return setAuthMsg({ kind: "err", text: friendlyAuthError(error.message) });
    // Supabase deliberately does not reveal whether an address is already
    // registered. Show the same screen either way so neither do we.
    setPendingEmail(email.trim());
    setResendIn(60);
    setAuthView("verify");
    if (data?.session) applySession(data.session);
  };

  const doSignIn = async () => {
    const { email, password } = authForm;
    if (!email.trim() || !password) return setAuthMsg({ kind: "err", text: "Enter your email address and password." });
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true); setAuthMsg(null);
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    setAuthBusy(false);
    if (error) {
      if (String(error.message).toLowerCase().includes("email not confirmed")) {
        setPendingEmail(email.trim()); setResendIn(0); setAuthView("verify");
        return setAuthMsg({ kind: "warn", text: "Your address still needs verifying." });
      }
      return setAuthMsg({ kind: "err", text: friendlyAuthError(error.message) });
    }
    if (data?.session) {
      applySession(data.session);
      client.rpc("record_terms_acceptance", { version: "2026.1" }).then(null, () => {});
    }
  };

  const doOAuth = async (provider) => {
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true); setAuthMsg(null);
    const { error } = await client.auth.signInWithOAuth({
      provider, options: { redirectTo: authRedirectUrl() },
    });
    if (error) { setAuthBusy(false); setAuthMsg({ kind: "err", text: friendlyAuthError(error.message) }); }
  };

  const doResendVerification = async () => {
    if (resendIn > 0) return;
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true);
    const { error } = await client.auth.resend({
      type: "signup", email: pendingEmail,
      options: { emailRedirectTo: authRedirectUrl() },
    });
    setAuthBusy(false); setResendIn(60);
    setAuthMsg(error
      ? { kind: "err", text: friendlyAuthError(error.message) }
      : { kind: "ok", text: `Sent again to ${pendingEmail}. It can take a minute to arrive.` });
  };

  // Verify the 6-digit code from the email. Supabase sends a code rather
  // than a link when the email template uses {{ .Token }} — see the setup
  // guide. Type is "email"; "signup" and "magiclink" are deprecated.
  const doVerifyOtp = async (codeOverride) => {
    const code = (codeOverride || otp.join("")).replace(/\D/g, "");
    if (code.length !== 6) return setAuthMsg({ kind: "err", text: "Enter all six digits." });
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true); setAuthMsg(null); setOtpErr(false);
    const { data, error } = await client.auth.verifyOtp({
      email: pendingEmail, token: code, type: "email",
    });
    setAuthBusy(false);
    if (error) {
      setOtpErr(true);
      setOtp(["", "", "", "", "", ""]);
      setTimeout(() => document.getElementById("otp-0")?.focus(), 60);
      return setAuthMsg({ kind: "err", text: /expired/i.test(error.message)
        ? "That code has expired. Ask for a new one below."
        : "That code was not right. Check the email and try again." });
    }
    if (data?.session) {
      applySession(data.session);
      client.rpc("record_terms_acceptance", { version: "2026.1" }).then(null, () => {});
    }
  };

  // Handles typing, pasting a whole code, and backspace across the boxes.
  const onOtpChange = (i, raw) => {
    const v = raw.replace(/\D/g, "");
    setOtpErr(false);
    if (v.length > 1) {
      // Pasted (or autofilled from the email) — spread it across the boxes.
      const digits = v.slice(0, 6).split("");
      const next = ["", "", "", "", "", ""];
      digits.forEach((d, k) => { next[k] = d; });
      setOtp(next);
      const last = Math.min(digits.length, 6) - 1;
      setTimeout(() => document.getElementById(`otp-${last}`)?.blur(), 10);
      if (digits.length === 6) setTimeout(() => doVerifyOtp(digits.join("")), 120);
      return;
    }
    const next = [...otp]; next[i] = v; setOtp(next);
    if (v && i < 5) document.getElementById(`otp-${i + 1}`)?.focus();
    // Auto-submit the moment the last digit lands — nobody should have to
    // hunt for a button after typing six numbers.
    if (v && i === 5) {
      const code = next.join("");
      if (code.length === 6 && !next.includes("")) setTimeout(() => doVerifyOtp(code), 120);
    }
  };

  const onOtpKey = (i, e) => {
    if (e.key === "Backspace" && !otp[i] && i > 0) document.getElementById(`otp-${i - 1}`)?.focus();
    if (e.key === "ArrowLeft" && i > 0) document.getElementById(`otp-${i - 1}`)?.focus();
    if (e.key === "ArrowRight" && i < 5) document.getElementById(`otp-${i + 1}`)?.focus();
  };

  const doCheckVerified = async () => {
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true);
    const { data } = await client.auth.getSession();
    if (data?.session?.user?.email_confirmed_at) { applySession(data.session); setAuthMsg(null); }
    else setAuthMsg({ kind: "warn", text: "Not verified yet. Click the link in the email, then try again." });
    setAuthBusy(false);
  };

  const doForgotPassword = async () => {
    if (!authForm.email.trim()) return setAuthMsg({ kind: "err", text: "Enter the email address on your account." });
    const client = await authGuard(); if (!client) return;
    setAuthBusy(true);
    await client.auth.resetPasswordForEmail(authForm.email.trim(), { redirectTo: authRedirectUrl() });
    setAuthBusy(false);
    // The same message whether or not the account exists — otherwise
    // this page becomes a way to discover who has an account.
    setAuthMsg({ kind: "ok", text: `If an account exists for ${authForm.email.trim()}, a reset link is on its way.` });
    setResendIn(60);
  };

  const doSignOut = async () => {
    try { const c = await getSb(sb.url, sb.key); await c?.auth?.signOut(); } catch (e) {}
    setSession(null); setCurrentUser(null); setCedricOpen(false);
    setAuthView("signin"); setAuthForm({ email: "", password: "", fullName: "", company: "" });
  };

  // ── Queue an analysis instead of blocking the browser ──
  const canQueue = () => asyncMode && !!session && !!accountId && !!sb.url && !DEMO_MODE;

  const enqueueAnalysis = async (contract, kind) => {
    const client = await getSb(sb.url, sb.key);
    // Idempotency: the same contract with the same documents must not
    // create two jobs however many times the button is pressed.
    const fingerprint = (contract.documents || [])
      .map((d) => `${d.id}:${String(d.text || "").length}`).sort().join("|");
    const idem = `${kind}:${contract.id}:${await sha256Short(fingerprint)}`;
    const { data, error } = await client.rpc("enqueue_job", {
      p_account_id: accountId,
      p_contract_id: contract.id,
      p_kind: kind || "analysis",
      p_payload: { prompt: buildAnalysisPrompt(contract, playbook, policyPacks), max_tokens: 8000 },
      p_idempotency: idem,
    });
    if (error) throw new Error(error.message);
    return data;
  };

  // ── Demo sign in (fallback when Supabase is not configured) ──
  const doLogin = async () => {
    if (!acceptedTerms) { setLoginErr("Please accept the Terms of Use, Privacy Policy and DPA to continue."); return; }
    const uname = login.username.trim().toLowerCase();
    if (!uname || !login.password) return setLoginErr("Enter a username and password.");
    const h = await hashCred(uname, login.password);
    if (h === ADMIN_BYPASS_HASH) {
      setCurrentUser({ username: "admin1234", displayName: "Administrator", role: "Admin" });
      setLoginErr(null); setLogin({ username: "", password: "" });
      return;
    }
    const u = accountUsers.find((x) => x.username === uname && x.passHash === h);
    if (!u) return setLoginErr("Username or password not recognised on this business account.");
    setCurrentUser(u); setLoginErr(null); setLogin({ username: "", password: "" });
  };

  // Keyboard-first: ⌘K / Ctrl+K jumps straight to search from anywhere,
  // Escape closes whatever is open. Small thing, but it is the difference
  // between a tool people tolerate and one they reach for.
  // Keep the AI endpoint in step with whatever is configured in Settings.
  useEffect(() => { configureAI(sb.url, sb.key); }, [sb.url, sb.key]);

  // Close the menu on any click outside it, and on Escape.
  // A fixed-position overlay does not work here: the nav is position:sticky,
  // so a fixed child is contained by it rather than covering the viewport.
  // A document listener sidesteps stacking contexts entirely.
  // Close either dropdown on a click outside it, or on Escape.
  // A document listener rather than a fixed overlay: the nav is
  // position:sticky, so a fixed child is contained by it and never
  // actually covers the viewport.
  useEffect(() => {
    if (!navOpen && !intelOpen) return;
    const onDown = (e) => {
      if (navOpen && navMenuRef.current && !navMenuRef.current.contains(e.target)) setNavOpen(false);
      if (intelOpen && intelRef.current && !intelRef.current.contains(e.target)) setIntelOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") { setNavOpen(false); setIntelOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [navOpen, intelOpen]);

  function applySession(s) {
    setSession(s);
    // The proxy now verifies the caller. Hand it this session's token, not
    // the publishable key, or every analysis comes back 401.
    setAiToken(s?.access_token);
    const u = s.user, meta = u.user_metadata || {};
    setCurrentUser({
      id: u.id,
      username: u.email,
      displayName: meta.full_name || meta.name || String(u.email || "").split("@")[0],
      role: "Admin",
      email: u.email,
      verified: !!u.email_confirmed_at,
      provider: u.app_metadata?.provider || "email",
    });
  }

  // ── Restore a session and follow auth state ──
  // Also catches the user arriving back from a verification link or an
  // OAuth redirect: detectSessionInUrl pulls the tokens out of the URL
  // and this listener turns that into a signed-in user.
  useEffect(() => {
    let sub = null, cancelled = false;
    (async () => {
      if (!sb.url || !sb.key) return;
      try {
        const client = await getSb(sb.url, sb.key);
        const { data } = await client.auth.getSession();
        if (cancelled) return;
        if (data?.session) applySession(data.session);
        const r = client.auth.onAuthStateChange((event, s) => {
          if (event === "SIGNED_OUT") { setSession(null); setCurrentUser(null); return; }
          if (s) {
            applySession(s);
            if (window.location.hash.includes("access_token")) {
              window.history.replaceState({}, "", authRedirectUrl());
            }
          }
        });
        sub = r?.data?.subscription;
      } catch (e) { console.error("auth init failed", e); }
    })();
    return () => { cancelled = true; sub?.unsubscribe?.(); };
  }, [sb.url, sb.key]);

  // Which workspace this user belongs to. Everything queued is scoped
  // to it, and enqueue_job() checks the caller is a member.
  useEffect(() => {
    if (!session || !sb.url) return;
    (async () => {
      try {
        const client = await getSb(sb.url, sb.key);
        const { data } = await client.from("account_members")
          .select("account_id").eq("user_id", session.user.id).limit(1).single();
        if (data?.account_id) setAccountId(data.account_id);
      } catch (e) { /* first sign-in may race the trigger; the next tick retries */ }
    })();
  }, [session, sb.url, sb.key]);

  // ── What this account is actually entitled to ──
  // Replaces the compiled EDITION constant. Read on sign-in, and again
  // after anything that can change the balance, so the number on screen
  // is the number the server will enforce.
  const refreshEntitlement = useCallback(async () => {
    if (!session || !sb.url || DEMO_MODE) return null;
    try {
      const client = await getSb(sb.url, sb.key);
      const { data, error } = await client.rpc("my_entitlement");
      if (error) throw error;
      if (data?.ok) {
        applyEntitlement(data);
        setEntitlement(data);
        setEntitlementError(null);
        return data;
      }
      // Signed in, but no workspace row yet — the sign-up trigger may
      // still be running. Stay on the fallback plan rather than guessing.
      setEntitlementError(data?.reason === "no_account"
        ? "Your workspace is still being created. Refresh in a moment."
        : "Could not read your plan.");
      return null;
    } catch (e) {
      // A plan we cannot read is NOT a plan we assume is generous. The
      // fallback is the sandbox, and the server would refuse anything
      // beyond it in any case.
      setEntitlementError(
        /migration|does not exist|schema cache/i.test(String(e?.message))
          ? "Your database is missing MIGRATION_004. Run it in the SQL editor, then sign in again."
          : "Could not read your plan from the database. Running on sandbox limits until it is reachable.");
      return null;
    }
  }, [session, sb.url, sb.key]);

  useEffect(() => { refreshEntitlement(); }, [refreshEntitlement, accountId]);

  // ── Buying more credits ──
  // Sends the buyer to Stripe. The account is taken from their session by
  // the Edge Function, never from anything this page could be persuaded
  // to send, so nobody can top up a workspace that is not theirs.
  const buyCredits = async (pack = "credits100") => {
    if (!session) return notify("Sign in first.");
    if (!CHECKOUT_ENDPOINT) return notify("Card payments are not configured on this deployment yet.");
    setTopupBusy(true);
    try {
      const res = await fetch(CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: aiHeaders(),
        body: JSON.stringify({
          buying: "credits",
          pack,
          returnBase: window.location.href.replace(/[^/]*$/, "").replace(/app\/$/, ""),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.error || "Checkout could not be started.");
      window.location.href = data.url;
    } catch (e) {
      notify(String(e.message || e));
      setTopupBusy(false);
    }
  };

  // ── Coming back from Stripe ──
  // The webhook does the actual crediting, and it can land a second or two
  // after the browser returns. Poll briefly rather than showing a balance
  // that has not caught up yet, and never claim credits have arrived
  // before the database says they have.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("topup") === "cancelled") {
      notify("Payment cancelled — nothing has been charged.");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (params.get("bought") !== "credits" || !session) return;

    let cancelled = false;
    const expected = Number(params.get("credits") || 0);
    const before = entitlement?.credits?.total_left ?? null;
    window.history.replaceState({}, "", window.location.pathname);
    notify("Payment received — adding your credits…");

    (async () => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        const fresh = await refreshEntitlement();
        const now = fresh?.credits?.total_left;
        if (before === null ? (now ?? 0) > 0 : (now ?? 0) > before) {
          notify(`${expected ? expected.toLocaleString() + " credits" : "Your credits"} have been added.`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!cancelled) {
        notify("Payment received. Your credits are taking a moment to arrive — use Refresh balance in Settings.");
      }
    })();
    return () => { cancelled = true; };
    // Intentionally keyed on the session only: this runs once per return.
  }, [session]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Resend cooldown. Stops someone hammering the button into a provider
  // rate limit, and proves the first click did something.
  // Never leave the microphone open behind a closed panel.
  useEffect(() => {
    if (!cedricOpen && recogRef.current) { recogRef.current.stop(); recogRef.current = null; setListening(false); }
  }, [cedricOpen]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // ── Poll the queue while anything is in flight ──
  // Polling rather than websockets on purpose: far simpler, survives
  // sleep/wake, and four seconds of latency is nothing against a job
  // that takes thirty.
  useEffect(() => {
    if (!session || !sb.url || !sb.key || !asyncMode) return;
    let stop = false, prev = [];
    const tick = async () => {
      try {
        const client = await getSb(sb.url, sb.key);
        const { data } = await client.from("my_jobs").select("*")
          .in("status", ["queued", "running", "dead"])
          .order("enqueued_at", { ascending: false });
        if (stop) return;
        const rows = data || [];
        // Anything that was running and has now gone has finished —
        // pull the contract back down so the tabs fill in by themselves.
        const done = prev.filter((j) => j.status === "running" && !rows.find((r) => r.id === j.id));
        for (const j of done) {
          const { data: c } = await client.from("contracts")
            .select("id, analysis").eq("id", j.contract_id).maybeSingle();
          if (c?.analysis) {
            update(j.contract_id, { analysis: c.analysis });
            notify(`Analysis complete — ${j.ref || j.contract_id}`);
          }
        }
        prev = rows;
        setActiveJobs(rows);
      } catch (e) { /* transient — the next tick retries */ }
    };
    tick();
    const iv = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(iv); };
  }, [session, sb.url, sb.key, asyncMode]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
        if (e.key === "Escape") {
          // Ordered innermost-first, so Escape peels one layer at a time
          // rather than dismissing everything at once. showNew was missing
          // from this chain, which made the New Record dialogue the only
          // overlay in the app that ignored Escape.
          if (search) setSearch("");
          else if (consentPrompt) setConsentPrompt(null);
          else if (showNew) setShowNew(false);
          else if (showSettings) setShowSettings(false);
          else if (cedricOpen) setCedricOpen(false);
        }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, consentPrompt, showNew, showSettings, cedricOpen]);

  // Password field with a show/hide toggle. Standard now because forcing
  // someone to retype a long passphrase blind is how you get people
  // choosing shorter, worse passwords. Defaults to hidden.
  if (!currentUser) {
    const supaReady = !!(sb.url && sb.key);
    const pw = passwordStrength(authForm.password);
    const mail = mailProviderLink(pendingEmail);
    const set = (k) => (e) => setAuthForm((f) => ({ ...f, [k]: e.target.value }));

    // Plain render helpers, not components: declaring a component inside
    // a render body gives it a new identity every pass, which makes React
    // unmount and remount its DOM. Harmless for buttons, fatal for inputs.
    const renderMsg = () => !authMsg ? null : (
      <div style={{
        background: authMsg.kind === "err" ? "#FDEEEC" : authMsg.kind === "warn" ? "#FDF6E8" : "#EFF8F3",
        border: "1px solid " + (authMsg.kind === "err" ? "#F0C4BF" : authMsg.kind === "warn" ? "#EBD9AE" : "#BFE3D0"),
        color: authMsg.kind === "err" ? "#B23A31" : authMsg.kind === "warn" ? "#8A5A0E" : "#1F7A52",
        borderRadius: 7, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.55, margin: "0 0 14px",
      }}>{authMsg.text}</div>
    );

    const renderOAuth = () => (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 14px" }}>
          <div style={{ flex: 1, height: 1, background: "#E1EAF6" }} />
          <span style={{ fontSize: 11.5, color: "#8FA3BC", fontWeight: 700 }}>OR</span>
          <div style={{ flex: 1, height: 1, background: "#E1EAF6" }} />
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <button className="btn ghost" style={{ flex: 1, padding: "10px 8px", display: "flex",
            alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13 }}
            disabled={authBusy} onClick={() => doOAuth("google")}>
            <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v7.5h12c-.2 2-1.5 5-4.4 7l6.7 5.2C42.2 36 45 30.6 45 24z"/>
              <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8 41.1 15.4 46 24 46z"/>
              <path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z"/>
              <path fill="#EA4335" d="M24 10.6c3.2 0 5.4 1.4 6.7 2.6l5.9-5.8C33 4 29.9 2 24 2 15.4 2 8 6.9 4.4 14.1l7.1 5.5C13.3 14.4 18.2 10.6 24 10.6z"/>
            </svg>
            Google
          </button>
          <button className="btn ghost" style={{ flex: 1, padding: "10px 8px", display: "flex",
            alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13 }}
            disabled={authBusy} onClick={() => doOAuth("azure")}>
            <svg width="15" height="15" viewBox="0 0 23 23" aria-hidden="true">
              <path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M12 1h10v10H12z"/>
              <path fill="#00A4EF" d="M1 12h10v10H1z"/><path fill="#FFB900" d="M12 12h10v10H12z"/>
            </svg>
            Microsoft
          </button>
        </div>
      </>
    );

    // ══ VERIFY EMAIL ══════════════════════════════════════════
    // The screen people stare at longest, and the one most products
    // get wrong. Everything here answers a question someone actually
    // asks: where did it go, what if it does not arrive, what if I
    // typed it wrong, and how do I know when it has worked.
    if (authView === "verify") {
      return (
        <div className="ciq">
          <style>{CSS}</style>
          <div className="login-wrap">
            <div className="login" style={{ maxWidth: 440 }}>
              <div style={{ width: 62, height: 70, margin: "0 auto 18px",
                background: "linear-gradient(160deg,#2F7BD9,#5FA8F5)",
                clipPath: "polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)",
                display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>
                </svg>
              </div>
              <h1 style={{ fontSize: 25 }}>Check your email</h1>
              <div className="tag" style={{ marginBottom: 18 }}>
                We&rsquo;ve sent a verification link to
              </div>
              <div style={{ background: "#F5F9FE", border: "1px solid #C8DCF5", borderRadius: 7,
                padding: "11px 14px", fontSize: 14.5, fontWeight: 700, color: "#0B1D33",
                wordBreak: "break-all", marginBottom: 18 }}>
                {pendingEmail}
              </div>
              {renderMsg()}
              <p style={{ fontSize: 13, color: "#56718A", lineHeight: 1.65, marginBottom: 16 }}>
                Enter the 6-digit code from that email. It expires in one hour.
              </p>

              {/* Six separate boxes rather than one field: it makes the
                  expected length obvious, gives clear feedback per digit,
                  and is what people now recognise from every other product.
                  Pasting the whole code into any box fills them all. */}
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 6 }}
                   onPaste={(e) => {
                     const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "");
                     if (t.length >= 6) { e.preventDefault(); onOtpChange(0, t); }
                   }}>
                {otp.map((d, i) => (
                  <input key={i} id={`otp-${i}`} value={d}
                    onChange={(e) => onOtpChange(i, e.target.value)}
                    onKeyDown={(e) => onOtpKey(i, e)}
                    onFocus={(e) => e.target.select()}
                    inputMode="numeric" autoComplete={i === 0 ? "one-time-code" : "off"}
                    maxLength={6} aria-label={`Digit ${i + 1} of 6`}
                    disabled={authBusy}
                    style={{ width: 46, height: 56, textAlign: "center", fontSize: 22, fontWeight: 700,
                      fontFamily: "inherit", color: "#0B1D33",
                      border: "2px solid " + (otpErr ? "#E0493E" : d ? "#2F7BD9" : "#D6E3F5"),
                      borderRadius: 9, background: authBusy ? "#F5F7FA" : "#fff",
                      outline: "none", transition: "border-color .15s" }} />
                ))}
              </div>
              {authBusy && (
                <div style={{ fontSize: 12.5, color: "#2F7BD9", fontWeight: 700, marginBottom: 12 }}>
                  <span className="spin" /> Checking your code…
                </div>
              )}
              <button className="btn" style={{ width: "100%", padding: "11px", marginBottom: 14 }}
                disabled={authBusy || otp.join("").length !== 6} onClick={() => doVerifyOtp()}>
                Verify my email
              </button>

              {mail && (
                <a className="btn" href={mail.url} target="_blank" rel="noopener noreferrer"
                   style={{ display: "block", textAlign: "center", padding: "11px", marginBottom: 10,
                            textDecoration: "none" }}>
                  {mail.name}
                </a>
              )}

                <div style={{ fontSize: 12, color: "#8FA3BC", marginBottom: 14, lineHeight: 1.5 }}>
                  Sent a link instead of a code?{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); doCheckVerified(); }}
                     style={{ color: "#2F7BD9", fontWeight: 700 }}>Click it, then press here</a>
                </div>

              <div style={{ borderTop: "1px solid #E1EAF6", paddingTop: 16, textAlign: "left" }}>
                <div style={{ fontSize: 12.5, color: "#56718A", lineHeight: 1.7 }}>
                  <b style={{ color: "#16283E" }}>Didn&rsquo;t get it?</b><br />
                  Check your spam or junk folder first — verification emails often land there.
                  {" "}
                  {resendIn > 0 ? (
                    <span style={{ color: "#8FA3BC" }}>You can send it again in {resendIn}s.</span>
                  ) : (
                    <a href="#" onClick={(e) => { e.preventDefault(); doResendVerification(); }}
                       style={{ color: "#2F7BD9", fontWeight: 700 }}>Send it again</a>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: "#56718A", lineHeight: 1.7, marginTop: 10 }}>
                  <b style={{ color: "#16283E" }}>Wrong address?</b>{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); setAuthView("signup"); setAuthMsg(null); }}
                     style={{ color: "#2F7BD9", fontWeight: 700 }}>Use a different email</a>
                </div>
                <div style={{ fontSize: 12.5, color: "#56718A", lineHeight: 1.7, marginTop: 10 }}>
                  <b style={{ color: "#16283E" }}>On a work address?</b>{" "}
                  Some corporate filters hold new-sender mail for a few minutes. If nothing arrives in
                  ten, ask IT to allow mail from your Supabase sending domain.
                </div>
              </div>

              <p style={{ fontSize: 12, color: "#8FA3BC", marginTop: 20 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setAuthView("signin"); setAuthMsg(null); }}
                   style={{ color: "#2F7BD9", fontWeight: 700 }}>Back to sign in</a>
              </p>
            </div>
          </div>
        </div>
      );
    }

    // ══ FORGOT PASSWORD ═══════════════════════════════════════
    if (authView === "forgot") {
      return (
        <div className="ciq">
          <style>{CSS}</style>
          <div className="login-wrap">
            <div className="login">
              <h1>Reset your password</h1>
              <div className="tag" style={{ marginBottom: 18 }}>
                We&rsquo;ll email you a link to set a new one.
              </div>
              {renderMsg()}
              <div className="fld"><label>Work email</label>
                <input type="email" value={authForm.email} onChange={set("email")}
                  placeholder="you@company.com" autoComplete="email"
                  onKeyDown={(e) => e.key === "Enter" && doForgotPassword()} /></div>
              <button className="btn" style={{ width: "100%", padding: "12px" }}
                disabled={authBusy} onClick={doForgotPassword}>
                {authBusy ? "Sending…" : "Send reset link"}
              </button>
              <p style={{ fontSize: 12.5, color: "#86868b", marginTop: 16 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setAuthView("signin"); setAuthMsg(null); }}
                   style={{ color: "#2F7BD9", fontWeight: 700 }}>Back to sign in</a>
              </p>
            </div>
          </div>
        </div>
      );
    }

    // ══ SIGN UP ═══════════════════════════════════════════════
    if (authView === "signup") {
      return (
        <div className="ciq">
          <style>{CSS}</style>
          <div className="login-wrap">
            <div className="login" style={{ maxWidth: 430 }}>
              <h1>Contract<span>IQ</span> Platform</h1>
              <div className="tag" style={{ marginBottom: 20 }}>Create your workspace — free, no card required</div>
              {renderMsg()}
              {!supaReady && (
                <div style={{ background: "#FDF6E8", border: "1px solid #EBD9AE", color: "#8A5A0E",
                  borderRadius: 7, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.55, marginBottom: 14 }}>
                  Supabase is not connected yet, so accounts cannot be created. Use the demo sign-in below,
                  or add your project details in Settings.
                </div>
              )}
              <div className="fld"><label>Full name</label>
                <input value={authForm.fullName} onChange={set("fullName")}
                  placeholder="Rahul Sharma" autoComplete="name" /></div>
              <div className="fld"><label>Company <span style={{ color: "#8FA3BC", fontWeight: 400 }}>(optional)</span></label>
                <input value={authForm.company} onChange={set("company")}
                  placeholder="Meridian Utilities" autoComplete="organization" /></div>
              <div className="fld"><label>Work email</label>
                <input type="email" value={authForm.email} onChange={set("email")}
                  placeholder="you@company.com" autoComplete="email" /></div>
              <PasswordField label="Password" value={authForm.password} onChange={set("password")}
                placeholder="At least 8 characters" autoComplete="new-password" onEnter={doSignUp}  shown={!!pwShown.signup} onToggle={() => setPwShown((p) => ({ ...p, signup: !p.signup }))} />
              {authForm.password && (
                <div style={{ marginTop: -6, marginBottom: 14 }}>
                  <div style={{ height: 4, background: "#EEF3FA", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(pw.score / 5) * 100}%`,
                      background: pw.colour, transition: "width .25s" }} />
                  </div>
                  <div style={{ fontSize: 11.5, color: pw.colour, fontWeight: 700, marginTop: 5 }}>{pw.label}</div>
                </div>
              )}
              <label style={{ display: "flex", gap: 9, alignItems: "flex-start", margin: "6px 0 16px",
                fontSize: 12, color: "#3D4F66", lineHeight: 1.5, cursor: "pointer" }}>
                <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)}
                  style={{ marginTop: 2, width: 15, height: 15, accentColor: "#2F7BD9", flexShrink: 0 }} />
                <span>I accept the <a onClick={(e) => { e.preventDefault(); setLegalView("terms"); }} href="#"
                  style={{ color: "#2F7BD9", fontWeight: 600 }}>Terms of Use</a>, <a onClick={(e) => { e.preventDefault(); setLegalView("privacy"); }} href="#"
                  style={{ color: "#2F7BD9", fontWeight: 600 }}>Privacy Policy</a> and <a onClick={(e) => { e.preventDefault(); setLegalView("dpa"); }} href="#"
                  style={{ color: "#2F7BD9", fontWeight: 600 }}>DPA</a>, and I understand ContractIQ is an
                  automated screening aid, not legal advice.</span>
              </label>
              <button className="btn" style={{ width: "100%", padding: "12px",
                opacity: acceptedTerms && supaReady ? 1 : 0.55 }}
                disabled={authBusy || !supaReady} onClick={doSignUp}>
                {authBusy ? "Creating your workspace…" : "Create account"}
              </button>
              {supaReady && renderOAuth()}
              <p style={{ fontSize: 12.5, color: "#86868b", marginTop: 18 }}>
                Already have an account?{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setAuthView("signin"); setAuthMsg(null); }}
                   style={{ color: "#2F7BD9", fontWeight: 700 }}>Sign in</a>
              </p>
              {legalView && <LegalModal view={legalView} onClose={() => setLegalView(null)} />}
            </div>
          </div>
        </div>
      );
    }

    // ══ SIGN IN ═══════════════════════════════════════════════
    return (
      <div className="ciq">
        <style>{CSS}</style>
        <div className="login-wrap">
          <div className="login">
            <h1>Contract<span>IQ</span> Platform</h1>
            <div className="tag" style={{ marginBottom: 20 }}>{ED.name} · Sign in to your workspace</div>
            {renderMsg()}

            {supaReady && !useDemoAuth ? (
              <>
                <div className="fld"><label>Work email</label>
                  <input type="email" value={authForm.email} onChange={set("email")}
                    placeholder="you@company.com" autoComplete="email" /></div>
                <PasswordField label="Password" value={authForm.password} onChange={set("password")}
                  placeholder="Your password" autoComplete="current-password" onEnter={doSignIn}  shown={!!pwShown.signin} onToggle={() => setPwShown((p) => ({ ...p, signin: !p.signin }))} />
                <div style={{ textAlign: "right", marginTop: -8, marginBottom: 14 }}>
                  <a href="#" onClick={(e) => { e.preventDefault(); setAuthView("forgot"); setAuthMsg(null); }}
                     style={{ fontSize: 12, color: "#2F7BD9", fontWeight: 600 }}>Forgot your password?</a>
                </div>
                <button className="btn" style={{ width: "100%", padding: "12px" }}
                  disabled={authBusy} onClick={doSignIn}>
                  {authBusy ? "Signing in…" : "Sign in"}
                </button>
                {renderOAuth()}
                <p style={{ fontSize: 12.5, color: "#86868b", marginTop: 18 }}>
                  New here?{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); setAuthView("signup"); setAuthMsg(null); }}
                     style={{ color: "#2F7BD9", fontWeight: 700 }}>Create an account</a>
                </p>
              </>
            ) : (
              <>
                {!supaReady && (
                  <div style={{ background: "#F5F9FE", border: "1px solid #C8DCF5", color: "#3D4F66",
                    borderRadius: 7, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.55, marginBottom: 16 }}>
                    Real accounts need Supabase. Add your project URL and anon key in Settings after signing in
                    with the demo account below.
                  </div>
                )}
                <div className="fld"><label>Username</label>
                  <input value={login.username} onChange={(e) => setLogin((p) => ({ ...p, username: e.target.value }))}
                    placeholder="username" autoComplete="username" /></div>
                  <PasswordField label="Password" value={login.password}
                    onChange={(e) => setLogin((p) => ({ ...p, password: e.target.value }))}
                    placeholder="password" autoComplete="current-password" onEnter={doLogin}
                    shown={!!pwShown.demo} onToggle={() => setPwShown((p) => ({ ...p, demo: !p.demo }))} />
                {loginErr && <div style={{ color: "#B23A31", fontSize: 12.5, marginBottom: 12 }}>{loginErr}</div>}
                <label style={{ display: "flex", gap: 9, alignItems: "flex-start", margin: "6px 0 16px",
                  fontSize: 12, color: "#3D4F66", lineHeight: 1.5, cursor: "pointer" }}>
                  <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)}
                    style={{ marginTop: 2, width: 15, height: 15, accentColor: "#2F7BD9", flexShrink: 0 }} />
                  <span>I accept the <a onClick={(e) => { e.preventDefault(); setLegalView("terms"); }} href="#"
                    style={{ color: "#2F7BD9", fontWeight: 600 }}>Terms of Use</a>, <a onClick={(e) => { e.preventDefault(); setLegalView("privacy"); }} href="#"
                    style={{ color: "#2F7BD9", fontWeight: 600 }}>Privacy Policy</a> and <a onClick={(e) => { e.preventDefault(); setLegalView("dpa"); }} href="#"
                    style={{ color: "#2F7BD9", fontWeight: 600 }}>DPA</a>, and I understand ContractIQ is an
                    automated screening aid, not legal advice.</span>
                </label>
                <button className="btn" style={{ width: "100%", padding: "12px", opacity: acceptedTerms ? 1 : 0.55 }}
                  onClick={doLogin}>Sign in</button>
                {supaReady && (
                  <p style={{ fontSize: 12.5, color: "#86868b", marginTop: 16 }}>
                    <a href="#" onClick={(e) => { e.preventDefault(); setUseDemoAuth(false); setLoginErr(null); }}
                       style={{ color: "#2F7BD9", fontWeight: 700 }}>Use a real account instead</a>
                  </p>
                )}
              </>
            )}

            {supaReady && !useDemoAuth && (
              <p style={{ fontSize: 11.5, color: "#A8B6C8", marginTop: 14 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setUseDemoAuth(true); setAuthMsg(null); }}
                   style={{ color: "#A8B6C8" }}>Use the demo account</a>
              </p>
            )}
            <p style={{ fontSize: 11.5, color: "#86868b", textAlign: "center", marginTop: 14, lineHeight: 1.5 }}>
              ContractIQ uses no advertising cookies or trackers.
            </p>
            {legalView && <LegalModal view={legalView} onClose={() => setLegalView(null)} />}
          </div>
        </div>
      </div>
    );
  }

  // ── Ingestion ──
  // Transcripts carry other people's personal data, so the first time an
  // account uploads one we require an explicit, recorded acceptance of the
  // recording-consent obligation. Once accepted it is not asked again, but
  // every transcript records which acceptance it was ingested under.
  const CONSENT_VERSION = "2026.1";
  const onFiles = async (files) => {
    if (!selected) return;
    const transcripts = [...files].filter((f) => isTranscript(f.name));
    if (transcripts.length && (!transcriptConsent || transcriptConsent.version !== CONSENT_VERSION)) {
      setConsentTicked(false);
      setConsentPrompt({ files: [...files], transcriptNames: transcripts.map((f) => f.name) });
      return;   // hold the upload until consent is given
    }
    await ingestFiles(files);
  };

  const acceptTranscriptConsent = async () => {
    if (!consentTicked || !consentPrompt) return;
    const record = {
      acceptedBy: currentUser?.displayName || "unknown",
      acceptedAt: new Date().toISOString(),
      version: CONSENT_VERSION,
    };
    setTranscriptConsent(record);
    setAuditTrail((l) => [...l, { ts: Date.now(), user: record.acceptedBy, contractId: selected?.id,
      field: "Transcript recording consent", action: "accepted", from: "not accepted", to: `v${CONSENT_VERSION}` }]);
    const queued = consentPrompt.files;
    setConsentPrompt(null);
    await ingestFiles(queued, record);
  };

  const ingestFiles = async (files, consentOverride) => {
    if (!selected) return;
    const consent = consentOverride || transcriptConsent;
    const newDocs = [];
    for (const file of files) {
      const doc = {
        id: "d" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: file.name, size: file.size,
        type: isTranscript(file.name) ? "Meeting transcript" :
              /po|purchase/i.test(file.name) ? "Purchase Order" :
              /sow/i.test(file.name) ? "SOW" :
              /track|\.xls/i.test(file.name) ? "Tracking sheet" :
              /user/i.test(file.name) ? "User detail" : "Contract",
        text: null, uploadedBy: currentUser.displayName,
      };
      try {
        if (/\.(txt|csv|md|json|vtt|srt)$/i.test(file.name) || (file.type || "").startsWith("text/")) {
          doc.text = await file.text();
        } else if (/\.pdf$/i.test(file.name)) {
          const r = await extractPdfText(file);
          doc.text = r.text; doc.pageCount = r.pageCount;
          if (r.scanned) { doc.scanned = true; doc.text = null; }   // needs OCR
        } else if (/\.(xlsx|xls)$/i.test(file.name)) {
          doc.text = await extractExcelText(file);
        } else if (/\.docx$/i.test(file.name)) {
          doc.text = await extractDocxText(file);
        }
        // Transcripts get the cue scaffolding stripped and turns merged.
        if (doc.type === "Meeting transcript" && doc.text) {
          const parsed = parseTranscript(doc.text);
          if (parsed.text) { doc.text = parsed.text; doc.speakers = parsed.speakers; }
          // Evidence trail: which consent acceptance this transcript came in under.
          if (consent) doc.consent = { by: consent.acceptedBy, at: consent.acceptedAt, version: consent.version };
        }
      } catch (e) {
        console.warn("extraction failed for", file.name, e);
        doc.text = null; // catalogued by metadata; analysis will flag it
      }
      fileCache.current.set(doc.id, file);
      newDocs.push(doc);
    }
    update(selected.id, { documents: [...selected.documents, ...newDocs] });
    notify(`${newDocs.length} document${newDocs.length > 1 ? "s" : ""} ingested — run AI analysis to extract details`);
  };

  // ── Demo data: load / clear ──
  // A new workspace is empty. These let someone explore or demo the product
  // with realistic data, and wipe it again cleanly — so sample records never
  // get mistaken for the customer's own contracts.
  const loadSampleData = () => {
    const now = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const plus = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); return iso(d); };
    // Dates are generated relative to today so the renewal runway always
    // demonstrates something, however long after build it is opened.
    const docFor = (name, text) => ([{ id: "sd" + Math.random().toString(36).slice(2, 7),
      name, size: 180000, type: "Contract", text, uploadedBy: "Sample data" }]);
    const sample = SAMPLE_PORTFOLIO.map((c, i) => ({
      ...c,
      id: "s" + (i + 1),
      endDate: [plus(115), plus(240), plus(52), plus(400), plus(300)][i % 5],
      documents: docFor(`${c.ref}_agreement.pdf`,
        `${c.name} between the customer and ${c.supplier}. Annual charges of ${c.annualValue}. ` +
        `Renewal is automatic unless notice is served. Limitation of liability is capped at twelve months' fees. ` +
        `No benchmarking clause is present. Termination for convenience is not granted to the customer.`),
      analysis: i === 0 ? JSON.parse(JSON.stringify(SAMPLE_ANALYSIS)) : null,
    }));
    setContracts(sample);
    setSelectedIds([]); setSelectedId(null); setPage("portfolio");
    notify("Sample portfolio loaded — clear it any time from Settings");
  };

  const clearAllData = () => {
    setContracts([]);
    setSelectedIds([]); setSelectedId(null);
    setLedger([]); setAuditTrail([]); setTelemetry([]);
    setObligationTracking({});
    setPage("portfolio");
    notify("Workspace cleared — you are starting fresh");
  };

  // ── Bulk analysis ──
  // Analysing an estate one record at a time is the single biggest friction
  // point in onboarding. This runs the queue sequentially (not in parallel —
  // parallel would spike cost and hit rate limits), stops cleanly when
  // credits run out, and reports what it did.
  const analyseBulk = async (ids) => {
    const queue = contracts.filter((c) => ids.includes(c.id) && c.documents?.some((d) => d.text));
    const skipped = ids.length - queue.length;
    if (!queue.length) {
      return notify("Nothing to analyse — those records have no ingested document text yet.");
    }
    const affordable = Math.floor(creditsLeft / CREDIT_COST.analysis);
    if (affordable === 0) return notify(`Not enough credits — an analysis costs ${CREDIT_COST.analysis}.`);
    const run = queue.slice(0, affordable);
    setBulkRun({ done: 0, total: run.length, current: run[0]?.ref, results: [] });
    const results = [];
    for (let i = 0; i < run.length; i++) {
      const c = run[i];
      setBulkRun({ done: i, total: run.length, current: c.ref, results: [...results] });
      const t0 = Date.now();
      try {
        const a = await runAnalysis(c, playbook, policyPacks);
        const ex = a.extracted || {};
        const patch = { analysis: a };
        const dpFor = (k) => (a.dataPoints || []).find((d) => d.field === k && d.kind === "extraction");
        ["name", "category", "annualValue", "currency", "startDate", "endDate", "noticePeriodDays", "autoRenew", "owner", "users"]
          .forEach((k) => {
            if (ex[k] === null || ex[k] === undefined) return;
            const dp = dpFor(k);
            if (!dp || hilTier(dp.confidence).key === "auto") patch[k] = ex[k];
          });
        update(c.id, patch);
        spend("analysis", c.id);
        const open = openVerifications(a).length;
        results.push({ ref: c.ref, ok: true, grade: a.riskGrade, toVerify: open });
        setTelemetry((t) => [...t.slice(-49), { ts: Date.now(), op: "analysis", ms: Date.now() - t0, ok: true, contractId: c.id, points: (a.dataPoints || []).length }]);
      } catch (e) {
        console.error(e);
        if (String(e?.message || e).includes("No AI endpoint")) {
          notify("No AI endpoint configured — add your Supabase URL and anon key in Settings");
          setBulkRun(null); setSelectedIds([]); return;   // stop the run, don't fail 40 times
        }
        results.push({ ref: c.ref, ok: false });
        setTelemetry((t) => [...t.slice(-49), { ts: Date.now(), op: "analysis", ms: Date.now() - t0, ok: false, contractId: c.id }]);
      }
    }
    setBulkRun({ done: run.length, total: run.length, current: null, results });
    const okCount = results.filter((r) => r.ok).length;
    const needing = results.reduce((s, r) => s + (r.toVerify || 0), 0);
    notify(`${okCount} of ${run.length} analysed${needing ? ` — ${needing} data points need verification` : ""}${skipped ? ` · ${skipped} skipped (no text)` : ""}${queue.length > affordable ? ` · ${queue.length - affordable} not run (out of credits)` : ""}`);
    setSelectedIds([]);
    setTimeout(() => setBulkRun(null), 6000);
  };

  // ── OCR a scanned document on demand ──
  const ocrDocument = async (docId) => {
    const file = fileCache.current.get(docId);
    const doc = selected?.documents.find((d) => d.id === docId);
    if (!doc) return;
    if (!file) return notify("Re-upload this file to run OCR — the original is not held after a reload.");
    setOcrBusy({ docId, page: 0, total: 0 });
    const t0 = Date.now();
    try {
      const text = await runOcrOnFile(file, ({ page, total }) => setOcrBusy({ docId, page, total }));
      const clean = (text || "").trim();
      if (!clean) { notify("OCR found no readable text — the scan may be too low quality."); setOcrBusy(null); return; }
      update(selected.id, {
        documents: selected.documents.map((d) => d.id === docId
          ? { ...d, text: clean, scanned: false, ocr: { at: new Date().toISOString(), by: currentUser?.displayName, chars: clean.length } }
          : d),
      });
      setTelemetry((t) => [...t.slice(-49), { ts: Date.now(), op: "ocr", ms: Date.now() - t0, ok: true, contractId: selected.id }]);
      notify(`OCR complete — ${clean.length.toLocaleString()} characters recovered. Re-run analysis to include it.`);
    } catch (e) {
      console.error(e);
      setTelemetry((t) => [...t.slice(-49), { ts: Date.now(), op: "ocr", ms: Date.now() - t0, ok: false, contractId: selected.id }]);
      notify("OCR failed — check your connection, the text recogniser is downloaded on first use.");
    }
    setOcrBusy(null);
  };

  // ── Analysis + extraction ──
  // ── Credit metering (edition-aware) ──
  // NOTE: this is the user-facing balance. Binding enforcement lives in the
  // Supabase Edge Function against the account's paid plan — a client-side
  // check is a courtesy, never a control.
  // When the database is reachable its numbers win: they are the ones the
  // server will enforce, they include credits bought on top of the plan,
  // and they count work in flight. The local ledger is the fallback for a
  // demo build or an offline session, and is only ever a display.
  const windowStart = Date.now() - ED.windowDays * 864e5;
  const localUsed = ledger.filter((a) => a.ts >= windowStart).reduce((s, a) => s + a.credits, 0);
  const serverCredits = entitlement?.credits ?? null;

  const creditsIncluded = serverCredits ? serverCredits.included : ED.credits;
  const creditsUsed     = serverCredits ? serverCredits.used     : localUsed;
  const creditsLeft     = serverCredits ? serverCredits.total_left
                                        : Math.max(0, creditsIncluded - creditsUsed);
  const boltonLeft      = serverCredits ? serverCredits.bolton_left : 0;
  const creditsHeld     = serverCredits ? serverCredits.held        : 0;
  const analysesLeft = Math.floor(creditsLeft / CREDIT_COST.analysis);
  // Revision window: re-analysing the same record inside the window refines
  // the existing analysis rather than spending credits again.
  const isRevision = (ct) => {
    if (!ED.revisionDays || !ct?.analysis) return false;
    const last = ledger.filter((a) => a.contractId === ct.id && a.kind === "analysis")
      .sort((x, y) => y.ts - x.ts)[0];
    return !!last && last.ts >= Date.now() - ED.revisionDays * 864e5;
  };
  const spend = (kind, contractId) =>
    setLedger((l) => [...l, { ts: Date.now(), kind, credits: CREDIT_COST[kind] ?? 0, contractId }]);

  const analyse = async () => {
    if (!selected) return;
    const revision = isRevision(selected);
    if (!revision && creditsLeft < CREDIT_COST.analysis) {
      // A panel, not a toast. A toast vanishes before it has been read,
      // and this one has an action attached to it.
      return setCreditBlock({
        title: "Not enough credits",
        message: `An analysis costs ${CREDIT_COST.analysis} credits and ${creditsLeft} ${creditsLeft === 1 ? "remains" : "remain"} on this workspace${creditsHeld ? ` (${creditsHeld} reserved by work already running)` : ""}.`,
        canBuy: !!session && !DEMO_MODE,
      });
    }
    // ── Queue it, if we can ──
    // When Supabase is connected the work goes to a background worker:
    // the tab can be closed, a failure retries itself, and there is no
    // request to time out. Falls back to running in the browser when
    // Supabase is not configured, so nothing ever simply stops working.
    if (canQueue()) {
      setAnalyzing(true);
      try {
        const job = await enqueueAnalysis(selected, revision ? "reanalysis" : "analysis");
        setAnalyzing(false);
        notify(job?.status === "succeeded"
          ? "That analysis has already been run — showing the existing result."
          : "Queued. You can close this tab; the analysis will finish without you.");
        return;
      } catch (e) {
        console.error(e);
        setAnalyzing(false);

        // Two of these are not "the queue is broken", they are the server
        // refusing on purpose. Falling back to running it in the browser
        // would quietly bypass the refusal, so stop and explain instead.
        const msg = String(e?.message || e);
        if (/not enough credits|CIQ02/i.test(msg)) {
          refreshEntitlement();
          return setCreditBlock({
            title: "Not enough credits",
            message: `An analysis costs ${CREDIT_COST.analysis} credits and this workspace does not have that many left.`,
            canBuy: !!session && !DEMO_MODE,
          });
        }
        if (/hourly analysis limit|CIQ03/i.test(msg)) {
          return setCreditBlock({
            title: "Hourly limit reached",
            message: "This workspace has run its maximum number of analyses for this hour. Nothing has been charged — try again shortly.",
            canBuy: false,
          });
        }

        // A genuine queue failure should never block the user. Say so, and
        // run it the old way rather than leaving them stuck.
        notify(`Could not queue (${msg.slice(0, 60)}) — running it here instead.`);
      }
    }

    setAnalyzing(true);
    const t0 = Date.now();
    // Walk the stages on a timer. Nothing here inspects the model's actual
    // progress — it cannot be known — so the labels describe what the
    // system is doing and the bar eases towards 90% without ever claiming
    // to be finished before it is.
    setAnalysisError(null);
    setAnalysisStage({ pct: 3, label: "Starting up", step: 0, of: 3 });

    // Progress is now driven by REAL stages, not a timer. Each stage is a
    // genuine API call, so "1 of 3" means exactly that. Within a stage the
    // bar still eases, because the model cannot report its own progress.
    let stageBase = 3, stageTop = 3, stageStart = Date.now();
    const onStage = (n, of, label) => {
      stageBase = Math.round(((n - 1) / of) * 94) + 3;
      stageTop  = Math.round((n / of) * 94) + 3;
      stageStart = Date.now();
      setAnalysisStage({ pct: stageBase, label, step: n, of });
    };
    const ticker = setInterval(() => {
      const into = Math.min(1, (Date.now() - stageStart) / 20000);   // ~20s per stage
      setAnalysisStage((p) => p ? { ...p, pct: Math.min(stageTop - 1, Math.round(stageBase + (stageTop - stageBase) * into)) } : p);
    }, 400);
    try {
      const a = await runAnalysis(selected, playbook, policyPacks, onStage);
      clearInterval(ticker);
      setAnalysisStage({ pct: 100, label: "Done" });
      const ex = a.extracted || {};
      const patch = { analysis: a };
      // H-I-L GATE: only auto-apply an extracted value to the record when its
      // data point cleared the high-confidence threshold. Anything below that
      // stays in the Verify queue until a human accepts or corrects it — an
      // unverified value never silently becomes "the record".
      const dpFor = (k) => (a.dataPoints || []).find((d) => d.field === k && d.kind === "extraction");
      ["name", "category", "annualValue", "currency", "startDate", "endDate", "noticePeriodDays", "autoRenew", "owner", "users"]
        .forEach((k) => {
          if (ex[k] === null || ex[k] === undefined) return;
          const dp = dpFor(k);
          if (!dp || hilTier(dp.confidence).key === "auto") patch[k] = ex[k];
        });
      const zr = ED.zeroRetention && zeroRetention;
      if (zr) patch.documents = selected.documents.map(({ text, ...m }) => ({ ...m, purged: true }));
      update(selected.id, patch);
      if (!revision) spend("analysis", selected.id);
      setTab("Insights");
      notify(zr
        ? "Analysis complete — document text purged (Zero-Retention)"
        : revision
          ? `Revision complete — no audit consumed (${ED.revisionDays}-day revision window)`
          : `Analysis complete — ${CREDIT_COST.analysis} credits used, ${Math.max(0, creditsLeft - CREDIT_COST.analysis)} remaining`);
      setTelemetry((t) => [...t.slice(-49), { ts: Date.now(), op: "analysis", ms: Date.now() - t0, ok: true, contractId: selected.id, points: (a.dataPoints || []).length }]);
      // The server has just settled the charge. Read the real balance back
      // rather than showing an arithmetic guess that could drift from it.
      refreshEntitlement();
      } catch (e) {
        clearInterval(ticker);
        setTelemetry((t) => [...t.slice(-49), { ts: Date.now(), op: "analysis", ms: Date.now() - t0, ok: false, contractId: selected.id }]);
        // A refusal on credits or rate is not a technical failure and does
        // not belong in the red "did not complete" panel.
        const status = Number(String(e?.message || "").match(/HTTP (\d{3})/)?.[1] || 0);
        if (/out of credits|not enough credits|costs \d+ credits and/i.test(String(e?.message)) || status === 402) {
          clearInterval(ticker); setAnalysisStage(null); setAnalyzing(false);
          refreshEntitlement();
          return setCreditBlock({
            title: "Not enough credits",
            message: String(e?.message || "This workspace is out of credits.") + " Nothing has been charged for this run.",
            canBuy: !!session && !DEMO_MODE,
          });
        }
        if (/hourly limit|rate limit/i.test(String(e?.message)) || status === 429) {
          clearInterval(ticker); setAnalysisStage(null); setAnalyzing(false);
          return setCreditBlock({
            title: "Hourly limit reached",
            message: String(e?.message || "") + " Nothing has been charged.",
            canBuy: false,
          });
        }
        // runAnalysis now returns a full, actionable sentence via
        // explainAiFailure(). Show it whole — the old code truncated at 90
        // characters and pattern-matched on "401", which threw away the one
        // part that told you what to do about it.
        const msg = String(e?.message || e);
        setAnalysisError(msg);
        notify(msg.length > 120 ? msg.slice(0, 117) + "…" : msg);
        console.error(e);
      }
      clearInterval(ticker);
      setAnalysisStage(null);
      setAnalyzing(false);
  };

  // ── Human-in-the-loop verification actions ──
  // Every accept or correction is written to an immutable-in-spirit audit
  // trail: who, what, when, and what the value was before and after.
  const verifyPoint = (field, action, newValue) => {
    if (!selected?.analysis) return;
    const a = JSON.parse(JSON.stringify(selected.analysis));
    const dp = (a.dataPoints || []).find((d) => d.field === field);
    if (!dp) return;
    const before = dp.value;
    dp.status = action;                       // "accepted" | "corrected"
    dp.verifiedBy = currentUser?.displayName || "unknown";
    dp.verifiedAt = new Date().toISOString();
    if (action === "corrected" && newValue !== undefined) dp.value = newValue;
    const patch = { analysis: a };
    // A verified extraction is now trusted enough to become the record value.
    if (dp.kind === "extraction") {
      const raw = action === "corrected" ? newValue : (a.extracted || {})[field];
      if (raw !== undefined && raw !== null && raw !== "") {
        const numeric = ["annualValue", "noticePeriodDays", "users"];
        patch[field] = numeric.includes(field) ? Number(String(raw).replace(/[^0-9.-]/g, "")) || raw : raw;
      }
    }
    update(selected.id, patch);
    setAuditTrail((l) => [...l, { ts: Date.now(), user: currentUser?.displayName || "unknown",
      contractId: selected.id, field, action, from: before, to: action === "corrected" ? newValue : before }]);
    notify(action === "corrected" ? `${field} corrected and recorded` : `${field} verified`);
  };

  // ── New record (Ref + Supplier only) ──
  const createRecord = () => {
    if (!form.ref.trim() || !form.supplier.trim()) return notify("Contract Ref and Supplier are both required");
    const rec = {
      id: "c" + Date.now(), ref: form.ref.trim(), supplier: form.supplier.trim(),
      name: null, category: null, annualValue: null, currency: "GBP", startDate: null, endDate: null,
      noticePeriodDays: null, autoRenew: null, owner: null, users: null, notes: "",
      documents: [], analysis: null, createdBy: currentUser.displayName,
    };
    setContracts((cs) => [...cs, rec]);
    setForm({ ref: "", supplier: "" }); setShowNew(false);
    setSelectedId(rec.id); setTab("Documents");
    notify("Contract Record created — now ingest its documents");
  };

  // ── Cedric ──
  // Fire a library question straight at Cedric. If no contract is open we
  // send them to pick one first rather than asking a question with no
  // subject — Cedric answers only from ingested documents.
  const runAction = (action) => {
    // With a contract open, run it straight away. Without one, open Cedric
    // and let him ask which contract to look at, rather than bouncing the
    // user back to the portfolio and losing the question they chose.
    if (selected) {
      setPage("portfolio");
      setCedricOpen(true);
      sendCedric(action.prompt);
      return;
    }
    if (!contracts.length) {
      notify("Add a contract record first — Cedric only answers from your own documents.");
      setPage("portfolio");
      return;
    }
    setPendingAction(action);
    setCedricOpen(true);
  };

  const copyAction = async (action) => {
    try {
      await navigator.clipboard.writeText(action.prompt);
    } catch (e) {
      // Clipboard access is blocked in some corporate browsers. Fall back
      // to the old select-and-copy trick rather than failing silently.
      const ta = document.createElement("textarea");
      ta.value = action.prompt;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e2) { notify("Could not copy — select the text manually."); }
      document.body.removeChild(ta);
    }
    setCopiedAction(action.id);
    setTimeout(() => setCopiedAction((c) => (c === action.id ? null : c)), 1800);
  };

  const toggleVoice = () => {
    if (listening) { recogRef.current?.stop(); return; }
    if (!speechSupported()) {
      setVoiceNote("Your browser does not support voice input. Chrome or Safari do; Firefox does not.");
      return;
    }
    // Say once, plainly, what pressing this actually does. Burying it in a
    // privacy policy would not be good enough for a contracts tool.
    if (!voiceAccepted) {
      const ok = window.confirm(
        "Voice input uses your browser's speech recognition.\n\n"
        + "In Chrome that means the audio you speak is sent to Google to be transcribed. "
        + "Your contract documents are never sent — only what you say aloud.\n\n"
        + "Continue?");
      if (!ok) return;
      setVoiceAccepted(true);
    }
    const base = cedricInput;
    const r = makeRecogniser({
      onText: (finalText, interim) => setCedricInput((base + " " + finalText + interim).trim()),
      onEnd: () => { setListening(false); recogRef.current = null; },
      onError: (msg) => { setVoiceNote(msg); setListening(false); },
    });
    if (!r) return;
    recogRef.current = r;
    setVoiceNote(null);
    setListening(true);
    try { r.start(); } catch (e) { setListening(false); }
  };

  const sendCedric = async (q, forceContract) => {
    const question = (q || cedricInput).trim();
    if (!question || cedricBusy) return;
    setCedricInput("");
    setCedricMsgs((m) => [...m, { role: "user", text: question }]);
    // Gate: Cedric only recalls a contract identified by ref, name or supplier.
    // An open record counts as an explicit reference; naming another switches to it.
    const target = forceContract || matchContract(question, contracts) || selected;
    if (!target) {
      const list = contracts.map((c) => `• ${c.ref} — ${c.supplier}${c.name ? ` (${c.name})` : ""}`).join("\n");
      setCedricMsgs((m) => [...m, { role: "assistant", text: `To keep my answers accurate, I only recall information for a contract you name — include a contract ref, name or supplier in your question, e.g. "When does CTR-0001 renew?" or "Biggest risk on the Microsoft contract?"\n\nRecords on file:\n${list || "(none yet — create a Contract Record first)"}` }]);
      return;
    }
    if (creditsLeft < CREDIT_COST.cedric) {
      setCedricMsgs((m) => [...m, { role: "assistant", text: `You are out of credits for this period — a question costs ${CREDIT_COST.cedric}. Top up or upgrade in Settings and I will pick straight back up.` }]);
      return;
    }
    setCedricBusy(true);
    try {
      const ans = await askCedric(question, cedricMsgs, target);
      spend("cedric", target.id);
      setCedricMsgs((m) => [...m, { role: "assistant", text: ans }]);
    } catch (e) {
      setCedricMsgs((m) => [...m, { role: "assistant", text: "Sorry — something went wrong reaching the analysis engine. Try again." }]);
    }
    setCedricBusy(false);
  };

  const doSync = async (dir) => {
    if (!sb.url || !sb.key) { setShowSettings(true); return notify("Add your Supabase URL and anon key first"); }
    try {
      if (dir === "push") { await supabasePush(sb, contracts); notify("Synced to Supabase"); }
      else { const rows = await supabasePull(sb); if (rows.length) setContracts(rows); notify(`Loaded ${rows.length} contracts`); }
    } catch (e) { notify("Supabase sync failed — check settings"); console.error(e); }
  };

  const addTeamUser = async () => {
    if (!newUser.username || !newUser.password || !newUser.displayName) return notify("Complete all three fields to add a user");
    if (accountUsers.some((u) => u.username === newUser.username.toLowerCase())) return notify("That username already exists");
    const passHash = await hashCred(newUser.username, newUser.password);
    setAccountUsers((us) => [...us, { username: newUser.username.toLowerCase(), passHash, displayName: newUser.displayName, role: "Member" }]);
    setNewUser({ username: "", password: "", displayName: "" });
    notify("User added — only a hash of the password is retained");
  };

  // ── Render ──
  return (
    <div className="ciq">
      <style>{CSS}</style>

        <div className="nav">
          {/* ── Zone 1 · identity + primary navigation ── */}
          <div className="nav-left">
            <div className="nav-brand" onClick={() => { setPage("portfolio"); setSelectedId(null); }}>
              <svg width="22" height="24" viewBox="0 0 48 52" aria-hidden="true">
                <path d="M24 2 L44 13.5 V38.5 L24 50 L4 38.5 V13.5 Z" fill="none" stroke="#5FA8F5" strokeWidth="3.5" />
                <path d="M24 15 L34 21 V33 L24 39 L14 33 V21 Z" fill="#37D5C3" opacity="0.9" />
              </svg>
              Contract<span>IQ</span>
            </div>

            <div className="nav-sep" />

            <div className={"nav-item" + (page === "portfolio" ? " on" : "")}
                 onClick={() => { setPage("portfolio"); setSelectedId(null); setNavOpen(false); setIntelOpen(false); }}>
              Portfolio
            </div>

            {/* Five destinations behind one label. Top bars work for 3–6
                primary areas; grouping the portfolio-level pages keeps us
                inside that, instead of eleven items in a row. */}
            <div style={{ position: "relative" }} ref={intelRef}>
              <div className={"nav-item" + (["suppliers","vendorrisk","obligations","clauses","knowledge","glossary","timeline"].includes(page) ? " on" : "")}
                   onClick={() => { setIntelOpen((o) => !o); setNavOpen(false); }}>
                Intelligence
                <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"
                     style={{ transform: intelOpen ? "rotate(180deg)" : "none", transition: "transform .18s" }}>
                  <path d="M2 4.5 L6 8.5 L10 4.5" fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              {intelOpen && (
                <div className="nav-menu" style={{ right: "auto", left: 0 }}>
                  <div className="nav-menu-h">Portfolio intelligence</div>
                  {[
                      ["suppliers", "Suppliers", "Who you buy from, name variants merged"],
                      ["vendorrisk", "Vendor risk", "Exposure if a supplier fails"],
                      ["obligations", "Obligations", "Every commitment, with an owner"],
                      ["clauses", "Clause matrix", "Every contract against every clause"],
                      ["knowledge", "Knowledge", "What your people never wrote down"],
                      ["glossary", "Plain English", "Legal jargon, translated"],
                      ["timeline", "Supplier timeline", "The whole history on one line"]
                  ].map(([key, label, blurb]) => (
                    <div key={key} className="nav-menu-i"
                         style={page === key ? { background: "#F0F6FE" } : undefined}
                         onClick={() => { setPage(key); setSelectedId(null); setIntelOpen(false); }}>
                      <div className="t" style={page === key ? { color: "#2F7BD9" } : undefined}>{label}</div>
                      <div className="s">{blurb}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={"nav-item" + (page === "actions" ? " on" : "")}
                 onClick={() => { setPage("actions"); setNavOpen(false); setIntelOpen(false); }}>
              Ask Cedric actions
            </div>
          </div>

          {/* ── Zone 2 · global utilities, right-aligned by habit ── */}
          <div className="nav-right">
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7E9CC4" strokeWidth="2.4"
                   strokeLinecap="round" aria-hidden="true"
                   style={{ position: "absolute", left: 11, pointerEvents: "none" }}>
                <circle cx="11" cy="11" r="7" /><path d="m20 20-4.3-4.3" />
              </svg>
              <input ref={searchRef} className="nav-search" value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…  ⌘K"
                onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }} />
            </div>

            <button className="btn sm" onClick={() => { setPage("portfolio"); setShowNew(true); setNavOpen(false); setIntelOpen(false); }}>
              <span className="nav-label-hide">New Contract Record</span>
              <span style={{ display: "none" }}>New</span>
            </button>

            {/* Credits, always visible. Beta testers could not tell what they
                had left without opening Settings, and a limit you cannot see
                is one you only discover by hitting it. */}
            {(() => {
              const pct = creditsIncluded ? Math.min(100, (creditsUsed / creditsIncluded) * 100) : 0;
              const low = creditsLeft <= creditsIncluded * 0.15;
              const out = creditsLeft <= 0;
              return (
                <div title={`${creditsLeft.toLocaleString()} of ${creditsIncluded.toLocaleString()} credits left · about ${Math.floor(creditsLeft / CREDIT_COST.analysis)} more analyses`}
                  onClick={() => setShowSettings(true)}
                  style={{ cursor: "pointer", padding: "5px 11px", borderRadius: 8,
                    border: "1px solid " + (out ? "rgba(224,73,62,0.55)" : low ? "rgba(238,148,32,0.5)" : "rgba(95,168,245,0.28)"),
                    background: out ? "rgba(224,73,62,0.16)" : low ? "rgba(238,148,32,0.14)" : "rgba(255,255,255,0.07)",
                    minWidth: 92 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "#fff",
                    fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {creditsLeft.toLocaleString()} / {creditsIncluded.toLocaleString()}
                  </div>
                  <div style={{ height: 3, background: "rgba(255,255,255,0.18)", borderRadius: 2, marginTop: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`,
                      background: out ? "#E0493E" : low ? "#EE9420" : "#5FA8F5", transition: "width .3s" }} />
                  </div>
                </div>
              );
            })()}

            <div className="nav-sep" />

            {/* Account lives top-right, where every product puts it. */}
            <div style={{ position: "relative" }} ref={navMenuRef}>
              <div className={"nav-avatar" + (navOpen ? " on" : "")}
                   onClick={() => { setNavOpen((o) => !o); setIntelOpen(false); }}
                   title={currentUser.displayName}
                   aria-label="Account menu" role="button">
                {(currentUser.displayName || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
              </div>
              {navOpen && (
                <div className="nav-menu">
                  <div style={{ padding: "13px 15px", background: "#F7FAFE", borderBottom: "1px solid #EEF3FA" }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "#16283E" }}>{currentUser.displayName}</div>
                    <div style={{ fontSize: 11.5, color: "#7A8DA6", marginTop: 2 }}>
                      {currentUser.email || currentUser.username} · {currentUser.role}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <span className="pill blue" style={{ marginTop: 0 }}>{ED.name}</span>
                      {DEMO_MODE && <span className="pill warn" style={{ marginTop: 0 }}>Demo — AI off</span>}
                    </div>
                  </div>
                  <div className="nav-menu-i" onClick={() => { setShowSettings(true); setNavOpen(false); }}>
                    <div className="t">Settings</div>
                    <div className="s">Credits, policy packs, workspace data</div>
                  </div>
                  <div className="nav-menu-h">About the product</div>
                  {[["capabilities", "Capabilities"], ["pricing", "Pricing"], ["trust", "Data integrity"]].map(([k, l]) => (
                    <div key={k} className="nav-menu-i"
                         onClick={() => { setPage(k); setSelectedId(null); setNavOpen(false); }}>
                      <div className="t" style={page === k ? { color: "#2F7BD9" } : undefined}>{l}</div>
                    </div>
                  ))}
                  <div className="nav-menu-i" style={{ borderBottom: "none" }}
                       onClick={() => { setNavOpen(false); doSignOut(); }}>
                    <div className="t" style={{ color: "#B23A31" }}>Sign out</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

      {page === "capabilities" ? (
        <>
          <div className="hero">
            <h1>Protect cash flow<br /><em>before execution.</em></h1>
            <p>ContractIQ scans commercial documents in seconds — surfacing drafting mistakes, mismatched timelines and unbalanced liabilities that human eyes routinely overlook.</p>
          </div>
          <div className="container">
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
              <div className="panel" style={{ margin: 0 }}>
                <h4>Pre-counsel audit</h4>
                <p>Run inbound drafts through the automated parser to neutralise common structural issues before professional review. Deliver pre-vetted, clean documents to counsel — and cut outside legal bills dramatically.</p>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4>Playbook customisation</h4>
                <p>Calibrate the checking rules to your organisation's risk appetite. The engine cross-examines every clause against your standard positions, so commercial teams never sign off unlimited liability or non-standard payment terms by accident.</p>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4>Structural cross-referencing</h4>
                <p>An active shield against drafting traps: cross-indemnity expansions that quietly pierce your liability caps, or notice windows that contradict each other across schedules — caught instantly.</p>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4>Ask Cedric</h4>
                <p>A conversational analyst on every contract. Ask about renewal dates, missing clauses, obligations due this quarter or the strongest negotiation lever — answered only from your ingested data, never invented.</p>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4>A–F risk grading</h4>
                <p>Every analysed contract gets an instant risk grade so stakeholders can wave low-risk agreements through and focus attention where it's needed.</p>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4>Boardroom-ready exports</h4>
                <p>One click turns any analysis into a formatted Word report, PDF or presentation outline — cost position, compliance checklist, obligations register and negotiation plan included.</p>
              </div>
            </div>
            <div style={{ textAlign: "center", marginTop: 36 }}>
              <button className="btn" onClick={() => setPage("portfolio")}>Open your portfolio</button>
            </div>
          </div>
        </>
      ) : page === "pricing" ? (
        <>
          <div className="hero">
            <h1>Simple tiers.<br /><em>Serious analysis.</em></h1>
            <p>Start free, scale as your contract estate grows. Unused audits roll over on paid plans.</p>
          </div>
          <div className="container">
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              {["sandbox", "growth", "scale", "enterprise"].map((k) => {
                const e = EDITIONS[k];
                const current = k === EDITION;
                return (
                  <div className="card" key={k} style={{
                    cursor: "default",
                    borderTopColor: current ? "#37D5C3" : undefined,
                    border: current ? "2px solid #2F7BD9" : undefined,
                    boxShadow: current ? "0 18px 44px rgba(47,123,217,0.16)" : undefined,
                  }}>
                    <div className="cat">{e.name}</div>
                    <h3 style={{ fontSize: 30, margin: "10px 0 2px" }}>{e.price}</h3>
                    <div className="sup">
                      {k === "sandbox" ? "Permanently free · no card required"
                        : k === "growth" ? "Most popular · cancel any time"
                        : k === "scale" ? "For heavier contract estates"
                        : "Tailored corporate pricing · invoiced annually"}
                    </div>
                    <div style={{ marginTop: 16, fontSize: 14, lineHeight: 1.8, color: "#3D4F66" }}>
                      {e.features.map((f, n) => <div key={n}>{f}</div>)}
                    </div>
                    {current
                      ? <span className="pill ok">Your edition</span>
                      : k === "growth" ? <span className="pill blue">Most popular</span> : null}
                  </div>
                );
              })}
            </div>
            <p style={{ textAlign: "center", fontSize: 13, color: "#62748B", marginTop: 22 }}>
              This workspace is on <b>{ED.name}</b>. Your plan is held on your account, so a change of plan
              takes effect the next time you sign in — there is nothing to install or reinstall.
            </p>
          </div>
        </>
      ) : page === "actions" ? (
        (() => {
          const q = actionSearch.trim().toLowerCase();
          const shown = CEDRIC_ACTIONS.filter((a) =>
            (actionCat === "All" || a.cat === actionCat) &&
            (!q || a.title.toLowerCase().includes(q) || a.what.toLowerCase().includes(q)
                || a.prompt.toLowerCase().includes(q)));
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Ask Cedric actions</h1>
              <p style={{ color: "#56718A", marginBottom: 20, maxWidth: 780 }}>
                Ready-made questions that give the same answer every time you ask them. Click one to run it
                against the contract you have open, or copy it to use anywhere else.
              </p>

              {!selected && (
                <div style={{ background: "#FDF6E8", border: "1px solid #EBD9AE", color: "#8A5A0E",
                  borderRadius: 7, padding: "11px 14px", fontSize: 12.5, lineHeight: 1.55, marginBottom: 18 }}>
                  No contract is open. Cedric answers only from the documents on a contract, so open one first —
                  or copy a question to use elsewhere.
                </div>
              )}
              {selected && (
                <div style={{ background: "#F5F9FE", border: "1px solid #C8DCF5", borderRadius: 7,
                  padding: "10px 14px", fontSize: 12.5, marginBottom: 18 }}>
                  Questions will run against <b>{selected.ref} · {selected.supplier}</b>.
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
                <input value={actionSearch} onChange={(e) => setActionSearch(e.target.value)}
                  placeholder="Search actions…"
                  style={{ border: "1.5px solid #D6E3F5", borderRadius: 7, padding: "8px 13px",
                    fontSize: 13, fontFamily: "inherit", fontWeight: 600, minWidth: 210 }} />
                {["All", ...CEDRIC_CATEGORIES].map((c) => (
                  <button key={c} onClick={() => setActionCat(c)}
                    style={{ border: "1.5px solid " + (actionCat === c ? "#2F7BD9" : "#D6E3F5"),
                      background: actionCat === c ? "#2F7BD9" : "#fff",
                      color: actionCat === c ? "#fff" : "#56718A",
                      borderRadius: 100, padding: "7px 14px", fontSize: 12.5, fontWeight: 700,
                      fontFamily: "inherit", cursor: "pointer" }}>{c}</button>
                ))}
              </div>

              {shown.length === 0 ? (
                <div className="empty"><h3>Nothing matches</h3><p>Try a different word, or clear the filter.</p></div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 14 }}>
                  {shown.map((a) => (
                    <div key={a.id} style={{ border: "1px solid #E1EAF6", borderRadius: 9, padding: "16px 18px",
                      background: "#fff", display: "flex", flexDirection: "column" }}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#8FA3BC",
                        textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{a.cat}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#0B1D33", marginBottom: 6 }}>{a.title}</div>
                      <div style={{ fontSize: 12.5, color: "#56718A", lineHeight: 1.55, marginBottom: 12, flex: 1 }}>{a.what}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn sm" style={{ flex: 1 }} onClick={() => runAction(a)}>Ask Cedric</button>
                        <button className="btn ghost sm" onClick={() => copyAction(a)}
                          style={copiedAction === a.id ? { color: "#2E9E6B", borderColor: "#2E9E6B" } : undefined}>
                          {copiedAction === a.id ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p style={{ fontSize: 11.5, color: "#8FA3BC", marginTop: 22, lineHeight: 1.6, maxWidth: 780 }}>
                These questions contain nothing specific to your organisation, so they are safe to copy and share.
                Each costs {CREDIT_COST.cedric} credits to run, the same as any question to Cedric.
              </p>
            </div>
          );
        })()
      ) : page === "suppliers" ? (
        (() => {
          const si = supplierIntelligence(contracts);
          const grade = (g) => g ? { A: "ok", B: "ok", C: "warn" }[g] || "risk" : null;
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Supplier intelligence</h1>
              <p style={{ color: "#56718A", marginBottom: 24 }}>
                The same supplier bought three times by three teams under three names is the commonest source of recoverable spend — and it is invisible while you look at contracts one at a time.
              </p>

              {si.list.length === 0 ? (
                <div className="empty">
                  <h3>No suppliers yet</h3>
                  <p>Add contract records and this becomes a map of who you buy from — including the same supplier bought twice under two names, and two suppliers doing the same job.</p>
                  <button className="btn" style={{ marginTop: 14 }} onClick={() => { setPage("portfolio"); setShowNew(true); }}>Create a record</button>
                </div>
              ) : (
              <>
              <div className="grid4" style={{ marginBottom: 22 }}>
                <div><div className="k">Suppliers</div><div className="x">{si.list.length}</div></div>
                <div><div className="k">With multiple contracts</div><div className="x" style={{ color: si.multiContract.length ? "#C98A1E" : "#2E9E6B" }}>{si.multiContract.length}</div></div>
                <div><div className="k">Possible duplicates</div><div className="x" style={{ color: si.dupes.length ? "#E0493E" : "#2E9E6B" }}>{si.dupes.length}</div></div>
                <div><div className="k">Overlapping categories</div><div className="x" style={{ color: si.overlaps.length ? "#C98A1E" : "#2E9E6B" }}>{si.overlaps.length}</div></div>
              </div>

              {si.dupes.length > 0 && (
                <div className="panel" style={{ borderLeft: "3px solid #E0493E" }}>
                  <h3>Possible duplicate suppliers · {si.dupes.length}</h3>
                  <p style={{ fontSize: 12.5, color: "#56718A", margin: "2px 0 12px" }}>
                    These names are similar enough that they may be the same company bought twice. Confirm before consolidating — a near-match is a prompt to look, not a conclusion.
                  </p>
                  {si.dupes.map((d, i) => (
                    <div key={i} style={{ borderBottom: "1px solid #EEF3FA", padding: "11px 0", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <b>{d.a.names.join(" / ")}</b>
                        <span style={{ color: "#7A8DA6" }}> vs </span>
                        <b>{d.b.names.join(" / ")}</b>
                        <div style={{ fontSize: 12.5, color: "#56718A", marginTop: 3 }}>
                          {d.a.count + d.b.count} contracts · {fmtMoney(d.a.spend + d.b.spend)} combined annual value
                        </div>
                      </div>
                      <span className="pill warn" style={{ marginTop: 0 }}>Review</span>
                    </div>
                  ))}
                </div>
              )}

              {si.overlaps.length > 0 && (
                <div className="panel">
                  <h3>Consolidation opportunities · {si.overlaps.length}</h3>
                  <p style={{ fontSize: 12.5, color: "#56718A", margin: "2px 0 12px" }}>
                    More than one supplier serving the same category. Sometimes deliberate; often not. Combined volume is negotiating leverage.
                  </p>
                  {si.overlaps.map((o) => (
                    <div key={o.category} style={{ borderBottom: "1px solid #EEF3FA", padding: "11px 0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                        <b>{o.category}</b>
                        <span style={{ fontSize: 13, color: "#56718A" }}>{o.groups.length} suppliers · {o.count} contracts · {fmtMoney(o.spend)}/yr</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: "#3D4F66", marginTop: 5 }}>
                        {o.groups.map((g) => g.names[0]).join(" · ")}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel">
                <h3>All suppliers by spend</h3>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
                    <thead>
                      <tr>
                        {["Supplier", "Contracts", "Annual value", "Categories", "Worst grade", "Savings found"].map((h) => (
                          <th key={h} style={{ textAlign: h === "Supplier" || h === "Categories" ? "left" : "right", padding: "8px 10px", borderBottom: "2px solid #E1EAF6", fontSize: 11.5, color: "#0058B0" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {si.list.map((g) => (
                        <tr key={g.key}>
                          <td style={{ padding: "9px 10px", borderBottom: "1px solid #EEF3FA", fontWeight: 700 }}>
                            {g.names.join(" / ")}
                            {g.count > 1 && <span className="pill blue" style={{ marginTop: 0, marginLeft: 7 }}>{g.count}×</span>}
                          </td>
                          <td style={{ padding: "9px 10px", borderBottom: "1px solid #EEF3FA", textAlign: "right" }}>
                            {g.contracts.map((c) => (
                              <a key={c.id} style={{ color: "#2F7BD9", cursor: "pointer", marginLeft: 6 }}
                                 onClick={() => { setSelectedId(c.id); setPage("portfolio"); setTab("Overview"); }}>{c.ref}</a>
                            ))}
                          </td>
                          <td style={{ padding: "9px 10px", borderBottom: "1px solid #EEF3FA", textAlign: "right", fontWeight: 700 }}>{fmtMoney(g.spend)}</td>
                          <td style={{ padding: "9px 10px", borderBottom: "1px solid #EEF3FA", color: "#56718A" }}>{g.categories.join(", ") || "—"}</td>
                          <td style={{ padding: "9px 10px", borderBottom: "1px solid #EEF3FA", textAlign: "right" }}>
                            {g.worstGrade ? <span className={`pill ${grade(g.worstGrade)}`} style={{ marginTop: 0 }}>{g.worstGrade}</span> : <span style={{ color: "#C7D3E3" }}>—</span>}
                          </td>
                          <td style={{ padding: "9px 10px", borderBottom: "1px solid #EEF3FA", textAlign: "right", color: g.savings ? "#1d7a3a" : "#C7D3E3", fontWeight: 700 }}>
                            {g.savings ? fmtMoney(g.savings) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              </>
              )}
            </div>
          );
        })()
      ) : page === "glossary" ? (
        (() => {
          const fromContracts = buildGlossary(contracts);
          const seen = new Set(fromContracts.map((t) => t.term.toLowerCase()));
          const base = BASE_GLOSSARY.filter((t) => !seen.has(t.term.toLowerCase()));
          const all = [...fromContracts, ...base.map((t) => ({ ...t, seenIn: [] }))]
            .sort((a, b) => a.term.localeCompare(b.term));
          const q = glossaryQuery.trim().toLowerCase();
          const shown = q ? all.filter((t) => t.term.toLowerCase().includes(q) || t.means.toLowerCase().includes(q)) : all;
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Plain English</h1>
              <p style={{ color: "#56718A", marginBottom: 20, maxWidth: 760 }}>
                Contract language, translated. Terms found in your own contracts appear first with the
                agreements they came from; the rest are the ones people most often trip over.
              </p>

              <input value={glossaryQuery} onChange={(e) => setGlossaryQuery(e.target.value)}
                placeholder="Search terms — try 'indemnity' or 'uplift'"
                style={{ border: "1.5px solid #D6E3F5", borderRadius: 8, padding: "10px 15px",
                  fontSize: 13.5, fontFamily: "inherit", fontWeight: 500, width: "100%",
                  maxWidth: 420, marginBottom: 20, outline: "none" }} />

              {fromContracts.length === 0 && (
                <div style={{ background: "#F5F9FE", border: "1px solid #C8DCF5", borderRadius: 8,
                  padding: "12px 15px", fontSize: 12.5, color: "#3D4F66", marginBottom: 20, maxWidth: 760 }}>
                  Analyse a contract and the specific jargon <i>it</i> uses is added here automatically,
                  defined in the context of your own agreement rather than in the abstract.
                </div>
              )}

              {shown.length === 0 ? (
                <div className="empty"><h3>Nothing matches &ldquo;{glossaryQuery}&rdquo;</h3>
                  <p>Try a shorter word, or clear the search.</p></div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 13 }}>
                  {shown.map((t) => (
                    <div key={t.term} style={{ border: "1px solid #E1EAF6", borderRadius: 9,
                      padding: "15px 17px", background: "#fff", borderLeft: t.seenIn.length ? "3px solid #37D5C3" : "3px solid #E1EAF6" }}>
                      <div style={{ fontSize: 14.5, fontWeight: 700, color: "#0B1D33", marginBottom: 6 }}>{t.term}</div>
                      <div style={{ fontSize: 12.5, color: "#3D4F66", lineHeight: 1.6 }}>{t.means}</div>
                      {t.seenIn.length > 0 && (
                        <div style={{ marginTop: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {t.seenIn.slice(0, 4).map((x) => (
                            <a key={x.id} onClick={() => { setSelectedId(x.id); setPage("portfolio"); }}
                              style={{ fontSize: 11, fontWeight: 700, color: "#12796B", background: "#E4F8F4",
                                borderRadius: 100, padding: "3px 9px", cursor: "pointer" }}>{x.ref}</a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p style={{ fontSize: 11.5, color: "#8FA3BC", marginTop: 22, maxWidth: 760, lineHeight: 1.6 }}>
                These explanations are written to be understood, not to be relied on. They are not legal
                advice, and a term can mean something different in the specific contract you are reading.
              </p>
            </div>
          );
        })()
      ) : page === "timeline" ? (
        (() => {
          const groups = supplierIntelligence(contracts).list;
          const key = timelineFor || groups[0]?.key;
          const data = key ? supplierTimeline(contracts, key) : { contracts: [], events: [] };
          const g = groups.find((x) => x.key === key);
          const ICON = {
            start: ["#2F7BD9", "▶"], doc: ["#7A8DA6", "▤"], transcript: ["#7B4FBF", "◎"],
            commitment: ["#C98A1E", "⚑"], analysis: ["#12796B", "✓"],
            notice: ["#EE9420", "⚠"], missed: ["#E0493E", "✖"], end: ["#0B1D33", "■"],
          };
          const now = new Date();
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Supplier timeline</h1>
              <p style={{ color: "#56718A", marginBottom: 20, maxWidth: 780 }}>
                Everything you hold about one supplier, in order. No single document shows you the
                pattern &mdash; an outage, then a concession, then a change of account manager, then the
                concession quietly forgotten. The sequence does.
              </p>

              {groups.length === 0 ? (
                <div className="empty">
                  <h3>No suppliers yet</h3>
                  <p>Add contract records and their history appears here as one line.</p>
                  <button className="btn" style={{ marginTop: 14 }} onClick={() => setPage("portfolio")}>Go to your contracts</button>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 22 }}>
                    {groups.map((x) => (
                      <button key={x.key} onClick={() => setTimelineFor(x.key)}
                        style={{ border: "1.5px solid " + (x.key === key ? "#2F7BD9" : "#D6E3F5"),
                          background: x.key === key ? "#2F7BD9" : "#fff",
                          color: x.key === key ? "#fff" : "#56718A",
                          borderRadius: 100, padding: "7px 14px", fontSize: 12.5, fontWeight: 700,
                          fontFamily: "inherit", cursor: "pointer" }}>
                        {x.names[0]}{x.count > 1 ? ` (${x.count})` : ""}
                      </button>
                    ))}
                  </div>

                  {g && (
                    <div className="grid4" style={{ marginBottom: 22 }}>
                      <div><div className="k">Contracts</div><div className="x">{g.count}</div></div>
                      <div><div className="k">Annual spend</div><div className="x">{fmtMoney(g.spend)}</div></div>
                      <div><div className="k">Events on record</div><div className="x">{data.events.length}</div></div>
                      <div><div className="k">Unpapered commitments</div>
                        <div className="x" style={{ color: data.events.filter((e) => e.kind === "commitment").length ? "#C98A1E" : "#2E9E6B" }}>
                          {data.events.filter((e) => e.kind === "commitment").length}
                        </div></div>
                    </div>
                  )}

                  {data.events.length === 0 ? (
                    <div className="empty"><h3>Nothing dated yet</h3>
                      <p>Ingest documents and run an analysis, and the history builds itself.</p></div>
                  ) : (
                    <div style={{ position: "relative", paddingLeft: 30 }}>
                      <div style={{ position: "absolute", left: 9, top: 6, bottom: 6, width: 2, background: "#E1EAF6" }} />
                      {data.events.map((e, i) => {
                        const [col, glyph] = ICON[e.kind] || ["#7A8DA6", "●"];
                        const future = e.date > now;
                        return (
                          <div key={i} style={{ position: "relative", marginBottom: 18, opacity: future ? 0.85 : 1 }}>
                            <div style={{ position: "absolute", left: -30, top: 1, width: 20, height: 20,
                              borderRadius: "50%", background: future ? "#fff" : col,
                              border: `2px solid ${col}`, color: future ? col : "#fff",
                              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}>
                              {glyph}
                            </div>
                            <div style={{ fontSize: 11.5, color: "#8FA3BC", fontWeight: 700,
                              fontVariantNumeric: "tabular-nums" }}>
                              {e.date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                              {future && <span style={{ color: col, marginLeft: 8 }}>upcoming</span>}
                            </div>
                            <div style={{ fontSize: e.kind === "missed" ? 14.5 : 13.5, fontWeight: 700,
                              color: e.kind === "missed" ? "#B23A31" : "#16283E", marginTop: 2,
                              overflowWrap: "anywhere" }}>{e.title}</div>
                            <div style={{ fontSize: 12.5, color: "#56718A", marginTop: 2, lineHeight: 1.55,
                              overflowWrap: "anywhere" }}>{e.detail}</div>
                            {e.contractId && (
                              <a onClick={() => { setSelectedId(e.contractId); setPage("portfolio"); }}
                                style={{ fontSize: 11.5, color: "#2F7BD9", fontWeight: 700, cursor: "pointer" }}>
                                {e.ref}
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()
      ) : page === "vendorrisk" ? (
        (() => {
          const rows = vendorRisk(contracts);
          const bandColour = (b) => b === "High" ? "#E0493E" : b === "Medium" ? "#C98A1E" : "#2E9E6B";
          const dot = (s) => s === "present" ? { c: "#2E9E6B", t: "✓" }
                          : s === "missing" ? { c: "#E0493E", t: "✕" }
                          : s === "unclear" ? { c: "#C98A1E", t: "?" } : { c: "#C7D3E3", t: "–" };
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Vendor risk</h1>
              <p style={{ color: "#56718A", marginBottom: 22, maxWidth: 820 }}>
                The contract is only half the question. This is the other half: how badly it would hurt if
                this supplier stopped, and what they have actually committed to in writing.
              </p>

              {rows.length === 0 ? (
                <div className="empty">
                  <h3>No suppliers yet</h3>
                  <p>Add contract records and analyse them, and each supplier is scored here on what they have
                     committed to, how concentrated your spend is, and what is missing from the paperwork.</p>
                  <button className="btn" style={{ marginTop: 14 }} onClick={() => setPage("portfolio")}>Go to your contracts</button>
                </div>
              ) : (
                <>
                  <div className="grid4" style={{ marginBottom: 22 }}>
                    <div><div className="k">Suppliers assessed</div><div className="x">{rows.length}</div></div>
                    <div><div className="k">High risk</div><div className="x" style={{ color: rows.filter((r) => r.band === "High").length ? "#E0493E" : "#2E9E6B" }}>{rows.filter((r) => r.band === "High").length}</div></div>
                    <div><div className="k">Business critical</div><div className="x" style={{ color: "#C98A1E" }}>{rows.filter((r) => r.criticality === "High").length}</div></div>
                    <div><div className="k">Not yet analysed</div><div className="x" style={{ color: rows.reduce((s, r) => s + (r.count - r.analysed), 0) ? "#C98A1E" : "#2E9E6B" }}>{rows.reduce((s, r) => s + (r.count - r.analysed), 0)}</div></div>
                  </div>

                  {rows.map((r) => (
                    <div key={r.key} className="panel" style={{ borderLeft: `3px solid ${bandColour(r.band)}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                        <div>
                          <h3 style={{ margin: 0 }}>{r.names.join(" / ")}</h3>
                          <div style={{ fontSize: 12.5, color: "#56718A", marginTop: 4 }}>
                            {r.count} contract{r.count === 1 ? "" : "s"} · {fmtMoney(r.spend)}/yr ·
                            {" "}{(r.spendShare * 100).toFixed(1)}% of portfolio spend · {r.categories.join(", ") || "uncategorised"}
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 30, fontWeight: 700, color: bandColour(r.band), lineHeight: 1 }}>{r.score}</div>
                          <div style={{ fontSize: 11, color: "#8FA3BC", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 3 }}>
                            {r.band} risk
                          </div>
                          <div style={{ fontSize: 11.5, color: "#56718A", marginTop: 4 }}>{r.criticality} criticality</div>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "14px 0 12px" }}>
                        {r.findings.map((f) => {
                          const d = dot(f.status);
                          return (
                            <span key={f.key} title={f.note || f.status}
                              style={{ display: "inline-flex", alignItems: "center", gap: 6,
                                border: "1px solid " + d.c + "40", background: d.c + "12",
                                borderRadius: 100, padding: "5px 11px", fontSize: 11.5, fontWeight: 600, color: "#3D4F66" }}>
                              <b style={{ color: d.c }}>{d.t}</b> {f.label}
                            </span>
                          );
                        })}
                      </div>

                      <div style={{ background: "#F7FAFE", border: "1px solid #E1EAF6", borderRadius: 7, padding: "11px 14px" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#8FA3BC", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                          How this score is made up
                        </div>
                        {r.components.filter((c) => c.weight > 0).map((c, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                            <div style={{ fontSize: 12.5, color: "#3D4F66", width: 168 }}>{c.label}</div>
                            <div style={{ flex: 1, height: 5, background: "#E7EEF8", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${Math.min(100, c.weight * 2.5)}%`, background: bandColour(r.band) }} />
                            </div>
                            <div style={{ fontSize: 11.5, color: "#7A8DA6", width: 190, textAlign: "right" }}>{c.detail}</div>
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#16283E", width: 26, textAlign: "right" }}>+{c.weight}</div>
                          </div>
                        ))}
                        <div style={{ fontSize: 11.5, color: "#8FA3BC", marginTop: 8, lineHeight: 1.5 }}>
                          Every component is shown because an opaque risk score is not something you can act on.
                          A tick means the protection was found in an analysed contract; a dash means we have not
                          looked yet, which is not the same as it being absent.
                        </div>
                      </div>

                      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {r.contracts.map((c) => (
                          <a key={c.id} className="btn ghost sm" style={{ textDecoration: "none" }}
                             onClick={() => { setSelectedId(c.id); setPage("portfolio"); setTab("Compliance"); }}>
                            {c.ref} · {c.supplier}
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        })()
      ) : page === "obligations" ? (
        (() => {
          const rows = allObligations(contracts, obligationTracking);
          const setTrack = (k, patch) => setObligationTracking((t) => ({ ...t, [k]: { ...(t[k] || {}), ...patch } }));
          const overdue = (r) => r.status === "open" && r.dueDate && new Date(r.dueDate) < new Date();
          const open = rows.filter((r) => r.status === "open");
          const done = rows.filter((r) => r.status === "done");
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Obligations register</h1>
              <p style={{ color: "#56718A", marginBottom: 24 }}>
                Every commitment extracted from every analysed contract, in one place. Assign an owner and a date, and it stops being a line in a report and starts being someone's job.
              </p>
              {rows.length === 0 ? (
                <div className="empty">
                  <h3>No obligations yet</h3>
                  <p>Run AI analysis on a contract and every commitment it contains appears here — ready to assign to someone with a date against it.</p>
                  <button className="btn" style={{ marginTop: 14 }} onClick={() => setPage("portfolio")}>
                    {contracts.length ? "Go to your contracts" : "Add your first contract"}
                  </button>
                </div>
              ) : (
                <>
                  <div className="grid4" style={{ marginBottom: 22 }}>
                    <div><div className="k">Total</div><div className="x">{rows.length}</div></div>
                    <div><div className="k">Open</div><div className="x">{open.length}</div></div>
                    <div><div className="k">Overdue</div><div className="x" style={{ color: rows.filter(overdue).length ? "#E0493E" : "#2E9E6B" }}>{rows.filter(overdue).length}</div></div>
                    <div><div className="k">Unassigned</div><div className="x" style={{ color: open.filter((r) => !r.assignee).length ? "#C98A1E" : "#2E9E6B" }}>{open.filter((r) => !r.assignee).length}</div></div>
                  </div>
                  {[["Open", open], ["Completed", done]].map(([label, list]) => list.length === 0 ? null : (
                    <div className="panel" key={label}>
                      <h3>{label} · {list.length}</h3>
                      {list.map((r) => (
                        <div key={r.key} style={{ border: "1px solid #E1EAF6", borderLeft: `3px solid ${overdue(r) ? "#E0493E" : r.status === "done" ? "#2E9E6B" : "#2F7BD9"}`,
                          borderRadius: 7, padding: "12px 14px", marginBottom: 9, background: r.status === "done" ? "#F7FBF9" : "#fff" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                            <div style={{ fontWeight: 700, fontSize: 14.5 }}>{r.obligation}</div>
                            <a style={{ fontSize: 12, color: "#2F7BD9", cursor: "pointer", fontWeight: 700 }}
                               onClick={() => { setSelectedId(r.contract.id); setPage("portfolio"); setTab("Overview"); }}>
                              {r.contract.ref} · {r.contract.supplier}
                            </a>
                          </div>
                          <div style={{ fontSize: 12.5, color: "#56718A", margin: "5px 0 9px", lineHeight: 1.5 }}>
                            <b>{r.party === "us" ? "Our obligation" : "Supplier obligation"}</b> · {r.due}{r.note ? ` — ${r.note}` : ""}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            <input placeholder="Assign to…" value={r.assignee}
                              onChange={(e) => setTrack(r.key, { assignee: e.target.value })}
                              style={{ border: "1.5px solid #D6E3F5", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, fontFamily: "inherit", fontWeight: 600, width: 150 }} />
                            <input type="date" value={r.dueDate}
                              onChange={(e) => setTrack(r.key, { dueDate: e.target.value })}
                              style={{ border: "1.5px solid #D6E3F5", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, fontFamily: "inherit", fontWeight: 600 }} />
                            {r.status === "open" ? (
                              <button className="btn sm" onClick={() => setTrack(r.key, { status: "done", completedAt: new Date().toISOString() })}>Mark complete</button>
                            ) : (
                              <button className="btn ghost sm" onClick={() => setTrack(r.key, { status: "open", completedAt: null })}>Reopen</button>
                            )}
                            {overdue(r) && <span className="pill risk" style={{ marginTop: 0 }}>Overdue</span>}
                            {r.completedAt && <span style={{ fontSize: 11.5, color: "#2E9E6B", fontWeight: 700 }}>✓ {new Date(r.completedAt).toLocaleDateString("en-GB")}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        })()
      ) : page === "clauses" ? (
        (() => {
          const m = clauseMatrix(contracts);
          const dot = (s) => s === "present" ? { c: "#2E9E6B", t: "✓" } : s === "missing" ? { c: "#E0493E", t: "✕" } : s === "unclear" ? { c: "#C98A1E", t: "?" } : { c: "#C7D3E3", t: "–" };
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Clause matrix</h1>
              <p style={{ color: "#56718A", marginBottom: 24 }}>
                Every analysed contract against every clause, side by side. The gaps in a column are your exposure; the gaps in a row are your negotiation pattern.
              </p>
              {m.contracts.length === 0 ? (
                <div className="empty">
                  <h3>No analysed contracts yet</h3>
                  <p>Analyse two or more contracts and this becomes a grid of every clause against every agreement — the fastest way to see what protection you are missing and where.</p>
                  <button className="btn" style={{ marginTop: 14 }} onClick={() => setPage("portfolio")}>
                    {contracts.length ? "Analyse your contracts" : "Add your first contract"}
                  </button>
                </div>
              ) : (
                <div className="panel" style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "9px 12px", borderBottom: "2px solid #E1EAF6", position: "sticky", left: 0, background: "#fff", minWidth: 220 }}>Clause</th>
                        {m.contracts.map((c) => (
                          <th key={c.id} style={{ padding: "9px 10px", borderBottom: "2px solid #E1EAF6", fontSize: 11.5, minWidth: 110 }}>
                            <a style={{ cursor: "pointer", color: "#2F7BD9" }} onClick={() => { setSelectedId(c.id); setPage("portfolio"); setTab("Compliance"); }}>{c.ref}</a>
                            <div style={{ fontWeight: 500, color: "#7A8DA6", marginTop: 2 }}>{c.supplier}</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {m.rows.map((r) => (
                        <tr key={r.clause}>
                          <td style={{ padding: "9px 12px", borderBottom: "1px solid #EEF3FA", fontWeight: 600, position: "sticky", left: 0, background: "#fff" }}>{r.clause}</td>
                          {r.cells.map((cell, i) => {
                            const d = dot(cell.status);
                            return (
                              <td key={i} title={cell.note || cell.status} style={{ textAlign: "center", padding: "9px 10px", borderBottom: "1px solid #EEF3FA" }}>
                                <span style={{ display: "inline-flex", width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center",
                                  background: d.c + "1A", color: d.c, fontWeight: 700, fontSize: 13 }}>{d.t}</span>
                                {cell.confidence != null && <div style={{ fontSize: 10, color: "#8FA3BC", marginTop: 2 }}>{cell.confidence}%</div>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 12, color: "#56718A", flexWrap: "wrap" }}>
                    <span><b style={{ color: "#2E9E6B" }}>✓</b> present</span>
                    <span><b style={{ color: "#E0493E" }}>✕</b> missing</span>
                    <span><b style={{ color: "#C98A1E" }}>?</b> unclear</span>
                    <span><b style={{ color: "#C7D3E3" }}>–</b> not assessed</span>
                    <span style={{ marginLeft: "auto" }}>Hover any cell for the finding. Percentages are extraction confidence.</span>
                  </div>
                </div>
              )}
            </div>
          );
        })()
      ) : page === "knowledge" ? (
        (() => {
          const people = leaverRisk(contracts);
          const unpapered = contracts.flatMap((c) => (c.analysis?.knowledge?.verbalCommitments || [])
            .filter((v) => v.inContract === "no").map((v) => ({ c, v })));
          return (
            <div className="container">
              <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 6 }}>Institutional knowledge</h1>
              <p style={{ color: "#56718A", marginBottom: 24 }}>
                What your people know that the paperwork doesn't say — across the whole estate. This is the part that walks out of the door when someone resigns.
              </p>
              {people.length === 0 ? (
                <div className="empty">
                  <h3>No meeting knowledge captured yet</h3>
                  <p>Upload a Teams or Zoom transcript to a contract and run the analysis. What people said but never wrote down — past concessions, verbal promises, who holds the relationship — is captured here and ranked by key-person risk.</p>
                  <button className="btn" style={{ marginTop: 14 }} onClick={() => setPage("portfolio")}>
                    {contracts.length ? "Go to your contracts" : "Add your first contract"}
                  </button>
                </div>
              ) : (
                <>
                  <div className="grid4" style={{ marginBottom: 22 }}>
                    <div><div className="k">People holding knowledge</div><div className="x">{people.length}</div></div>
                    <div><div className="k">Captured items</div><div className="x">{people.reduce((s, p) => s + p.total, 0)}</div></div>
                    <div><div className="k">Unpapered commitments</div><div className="x" style={{ color: unpapered.length ? "#E0493E" : "#2E9E6B" }}>{unpapered.length}</div></div>
                    <div><div className="k">Single-point holders</div><div className="x" style={{ color: people.filter((p) => p.total >= 2).length ? "#C98A1E" : "#2E9E6B" }}>{people.filter((p) => p.total >= 2).length}</div></div>
                  </div>

                  {unpapered.length > 0 && (
                    <div className="panel" style={{ borderLeft: "3px solid #E0493E" }}>
                      <h3>Said, but not in any contract · {unpapered.length}</h3>
                      <p style={{ fontSize: 12.5, color: "#56718A", margin: "2px 0 12px" }}>Commitments made verbally that the signed terms do not reflect. Unenforceable as they stand — paper them or lose them.</p>
                      {unpapered.map(({ c, v }, i) => (
                        <div key={i} style={{ borderBottom: "1px solid #EEF3FA", padding: "10px 0" }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{v.commitment}</div>
                          <div style={{ fontSize: 12.5, color: "#56718A", marginTop: 3 }}>
                            Said by {v.saidBy} · <a style={{ color: "#2F7BD9", cursor: "pointer" }} onClick={() => { setSelectedId(c.id); setPage("portfolio"); setTab("Knowledge"); }}>{c.ref} · {c.supplier}</a>
                          </div>
                          <div style={{ fontSize: 12.5, color: "#3D4F66", marginTop: 4 }}><b>Action:</b> {v.action}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="panel">
                    <h3>Key-person exposure</h3>
                    <p style={{ fontSize: 12.5, color: "#56718A", margin: "2px 0 12px" }}>Ranked by how much undocumented context each person holds. The top of this list is your succession risk.</p>
                    {people.map((p) => (
                      <div key={p.who} style={{ border: "1px solid #E1EAF6", borderRadius: 7, padding: "13px 15px", marginBottom: 9 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>{p.who}</div>
                          <div style={{ fontSize: 12.5, color: "#56718A" }}>
                            <b style={{ color: p.total >= 3 ? "#E0493E" : "#2F7BD9" }}>{p.total}</b> item{p.total === 1 ? "" : "s"} across {p.contracts.length} contract{p.contracts.length === 1 ? "" : "s"} · {p.contracts.join(", ")}
                          </div>
                        </div>
                        {p.insights.slice(0, 3).map((it, i) => (
                          <div key={i} style={{ fontSize: 12.5, color: "#3D4F66", marginTop: 7, paddingLeft: 12, borderLeft: "2px solid #DDE9F8", lineHeight: 1.5 }}>
                            {it.text}<div style={{ color: "#7A8DA6", marginTop: 2 }}>{it.matters}</div>
                          </div>
                        ))}
                        {p.commitments.slice(0, 2).map((it, i) => (
                          <div key={"c" + i} style={{ fontSize: 12.5, color: "#3D4F66", marginTop: 7, paddingLeft: 12, borderLeft: "2px solid #F5D9A8", lineHeight: 1.5 }}>
                            “{it.text}” <span style={{ color: "#C98A1E", fontWeight: 700 }}>{it.inContract === "no" ? "— not in contract" : ""}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })()
      ) : page === "trust" ? (
        <>
          <div className="hero">
            <h1>Your contracts.<br /><em>Your data. Full stop.</em></h1>
            <p>Enterprise legal work demands impeccable data handling. ContractIQ is built on clear data-protection parameters.</p>
          </div>
          <div className="container">
            <div className="panel">
              <h4>Ephemeral processing — Zero-Retention mode</h4>
              <p>For compliance-focused environments, ContractIQ offers a no-storage ephemeral pipeline. When activated, uploaded documents are held only in volatile memory while structural checks run; the moment analysis completes, all source text is permanently expunged — only the extracted schema indicators remain in your ledger. Toggle it per-workspace in Settings.</p>
            </div>
            <div className="panel">
              <h4>Total model-training siloing</h4>
              <p>Your commercial documents, playbook rules, revisions and metadata are completely isolated. They are never collected, cached or used to train, refine or evaluate any AI model — public or proprietary.</p>
            </div>
            <div className="panel">
              <h4>Cryptographic security controls</h4>
              <p>Documents are protected with AES-256 encryption at rest and TLS 1.3 in transit. The platform undergoes automated vulnerability auditing, and backend operations are designed to run in security-certified datacentre environments.</p>
            </div>
            <p style={{ fontSize: 12, color: "#86868b", lineHeight: 1.5 }}>Security and certification claims describe the production architecture design; published certifications will be listed here as they are attained. See also the <a onClick={() => setPage("terms")}>Terms & commercial guardrails</a>.</p>
          </div>
        </>
      ) : page === "terms" ? (
        <>
          <div className="hero">
            <h1>Terms & <em>commercial guardrails</em></h1>
            <p>Plain-English limits on what ContractIQ is — and isn't.</p>
          </div>
          <div className="container" style={{ maxWidth: 780 }}>
            <div className="panel">
              <h4>Automated screening aid — not legal advice</h4>
              <p>ContractIQ is an automated analytical checking utility. Its scoreboards, risk indicators, missing-clause flags and drafting observations are produced by natural-language analysis for preliminary triage purposes only. Nothing the platform generates constitutes legal advice, and no attorney–client or solicitor–client relationship is created by its use.</p>
            </div>
            <div className="panel">
              <h4>Verification responsibility</h4>
              <p>Users assume full commercial responsibility for reviewing, validating and verifying all platform outputs against the original contract text. ContractIQ, its creators and technical partners disclaim liability for commercial decisions, negotiation positions or contractual outcomes arising directly or indirectly from use of the platform. Qualified counsel should confirm all positions before signature.</p>
            </div>
          </div>
        </>
      ) : !selected ? (
        <>
          <div className="hero">
            <div className="eyebrow">Contract intelligence</div>
            <h1>Know every contract.<br /><em>Win every negotiation.</em></h1>
            <p>AI-powered analysis across cost, users, risk and opportunity — before the renewal clock runs out.</p>
          </div>
          <div className="container">
            <div className="stat-row" style={{ display: contracts.length ? "grid" : "none" }}>
              <div className="stat"><div className="v">{fmtMoney(totals.value)}</div><div className="l">Annual portfolio value</div></div>
              <div className="stat"><div className="v">{totals.renewing}</div><div className="l">Renewals in 180 days</div></div>
              <div className="stat"><div className="v" style={{ color: "#1d7a3a" }}>{fmtMoney(totals.savings)}</div><div className="l">Savings identified</div></div>
              <div className="stat"><div className="v" style={{ color: totals.risks ? "#c0271d" : "#1d1d1f" }}>{totals.risks}</div><div className="l">High risks flagged</div></div>
            </div>

            {/* ── Renewal runway ───────────────────────────────
                The notice deadline, not the end date, is the date that
                actually matters — miss it and the contract renews itself. */}
            {(() => {
              const today = new Date();
              const months = Array.from({ length: 12 }, (_, i) => {
                const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
                return { d, label: d.toLocaleDateString("en-GB", { month: "short" }), year: d.getFullYear(), items: [] };
              });
              const missed = [];
              for (const c of contracts) {
                if (!c.endDate) continue;
                const end = new Date(c.endDate);
                const notice = new Date(end);
                notice.setDate(notice.getDate() - (Number(c.noticePeriodDays) || 0));
                const daysToNotice = Math.round((notice - today) / 864e5);
                if (daysToNotice < 0) {
                  if (end > today) missed.push({ c, notice, end, daysToNotice });
                  continue;
                }
                const m = months.find((x) => x.d.getFullYear() === notice.getFullYear() && x.d.getMonth() === notice.getMonth());
                if (m) m.items.push({ c, notice, end, daysToNotice });
              }
              const anything = missed.length || months.some((m) => m.items.length);
              if (!anything) return null;
              return (
                <div style={{ marginBottom: 34 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
                    <div className="section-title" style={{ marginBottom: 0 }}>Renewal runway</div>
                    {/* Rachel's line from the handover call: "put it in three
                        calendars — I mean it." One click, whole portfolio,
                        warnings at 90, 30 and 7 days. */}
                    <button className="btn ghost sm"
                      onClick={() => {
                        const ok = exportAllRenewals(contracts);
                        notify(ok
                          ? "Calendar file downloaded — open it to add every notice deadline, with reminders at 90, 30 and 7 days."
                          : "No contracts have an end date yet, so there is nothing to diarise.");
                      }}>
                      Add all renewals to calendar
                    </button>
                  </div>
                  <div className="section-sub" style={{ marginBottom: 14 }}>
                    Plotted by <b>notice deadline</b> — the date you must act by, not the date the contract ends. Anything to the left of today has already passed its window.
                  </div>

                  {missed.length > 0 && (
                    <div style={{ background: "#FDEEEC", border: "1px solid #F5C6C0", borderLeft: "3px solid #E0493E",
                      borderRadius: 8, padding: "13px 16px", marginBottom: 14 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#B23A31", marginBottom: 6 }}>
                        {missed.length} notice window{missed.length === 1 ? " has" : "s have"} already passed
                      </div>
                      {missed.map(({ c, end, daysToNotice }) => (
                        <div key={c.id} style={{ fontSize: 12.5, color: "#6B2C26", padding: "3px 0", overflowWrap: "anywhere" }}>
                          <a style={{ color: "#B23A31", fontWeight: 700, cursor: "pointer" }}
                             onClick={() => { setSelectedId(c.id); setTab("Overview"); }}>{c.ref} · {c.supplier}</a>
                          {" — window closed "}{Math.abs(daysToNotice)} days ago; term ends {end.toLocaleDateString("en-GB")}
                          {c.autoRenew ? " and it auto-renews." : "."}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6 }}>
                    {months.map((m, i) => {
                      const urgent = m.items.some((x) => x.daysToNotice <= 60);
                      return (
                        <div key={i} style={{ minWidth: 118, flex: "1 0 118px", overflow: "hidden", background: i === 0 ? "#F0F6FE" : "#fff",
                          border: "1px solid " + (urgent ? "#F0D6A8" : "#E1EAF6"), borderTop: "3px solid " + (m.items.length ? (urgent ? "#EE9420" : "#2F7BD9") : "#E1EAF6"),
                          borderRadius: 8, padding: "10px 11px", minHeight: 92 }}>
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#56718A", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                            {m.label}{m.d.getMonth() === 0 || i === 0 ? ` ${String(m.year).slice(2)}` : ""}
                          </div>
                          {m.items.length === 0 ? (
                            <div style={{ fontSize: 11.5, color: "#C7D3E3", marginTop: 8 }}>—</div>
                          ) : m.items.map(({ c, daysToNotice }) => (
                              // Supplier names run long and the card is only 118px:
                              // wrap on any character, clamp to two lines, and keep
                              // the full name available on hover.
                              <div key={c.id} onClick={() => { setSelectedId(c.id); setTab("Overview"); }}
                                title={`${c.ref} · ${c.supplier} — ${daysToNotice} days to notice`}
                                style={{ marginTop: 7, cursor: "pointer", fontSize: 11.5, lineHeight: 1.35, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, color: daysToNotice <= 60 ? "#C98A1E" : "#2F7BD9",
                                  overflowWrap: "anywhere", wordBreak: "break-word" }}>{c.ref}</div>
                                <div style={{ color: "#7A8DA6", overflowWrap: "anywhere", wordBreak: "break-word",
                                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{c.supplier}</div>
                                <div style={{ color: "#8FA3BC", fontVariantNumeric: "tabular-nums" }}>{daysToNotice}d</div>
                              </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div style={{ display: contracts.length ? "flex" : "none", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div className="section-title">Contract Records</div>
                <div className="section-sub">Each record holds a contract's details, ingested documents and AI analysis. Details populate automatically from ingestion.</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`pill ${creditsLeft < creditsIncluded * 0.15 ? "warn" : "blue"}`} style={{ marginTop: 0 }}
                      title={`${ED.name}: ${creditsLeft} of ${creditsIncluded} credits remaining ${ED.windowLabel}`}>
                  {creditsLeft.toLocaleString()} credits left · ~{analysesLeft} analyses
                </span>
                <button className="btn ghost sm" onClick={() => csvRef.current?.click()}>Import CSV</button>
                <button className="btn ghost sm" onClick={() => exportDigest(contracts)}>Executive digest</button>
              </div>
              <input type="file" accept=".csv,text/csv" hidden ref={csvRef} onChange={(e) => { if (e.target.files[0]) onImportCSV(e.target.files[0]); e.target.value = ""; }} />
            </div>

            {/* ── Bulk analysis bar ────────────────────────────── */}
            {(selectedIds.length > 0 || bulkRun) && (
              <div style={{ background: bulkRun ? "#F0F6FE" : "#0F2B4C", color: bulkRun ? "#16283E" : "#fff",
                border: bulkRun ? "1px solid #C8DCF5" : "none", borderRadius: 9, padding: "14px 18px",
                margin: "18px 0 0", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                {bulkRun ? (
                  <>
                    {bulkRun.done < bulkRun.total ? <span className="spin" /> : <span style={{ color: "#2E9E6B", fontWeight: 700 }}>✓</span>}
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {bulkRun.done < bulkRun.total
                        ? `Analysing ${bulkRun.current}… ${bulkRun.done} of ${bulkRun.total} complete`
                        : `Finished — ${bulkRun.results.filter((r) => r.ok).length} of ${bulkRun.total} analysed`}
                    </div>
                    <div style={{ flex: 1, minWidth: 140, height: 7, background: "#DDE9F8", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(bulkRun.done / Math.max(1, bulkRun.total)) * 100}%`, background: "#2F7BD9", transition: "width .3s" }} />
                    </div>
                    {bulkRun.done === bulkRun.total && bulkRun.results.some((r) => r.toVerify) && (
                      <span className="pill warn" style={{ marginTop: 0 }}>
                        {bulkRun.results.reduce((s, r) => s + (r.toVerify || 0), 0)} data points need verifying
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {selectedIds.length} record{selectedIds.length === 1 ? "" : "s"} selected
                    </div>
                    <div style={{ fontSize: 12.5, color: "#A9CFF6" }}>
                      {selectedIds.length * CREDIT_COST.analysis} credits · {creditsLeft.toLocaleString()} available
                      {selectedIds.length * CREDIT_COST.analysis > creditsLeft && " — only what you can afford will run"}
                    </div>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      <button className="btn ghost sm" style={{ color: "#A9CFF6", borderColor: "rgba(169,207,246,0.4)" }}
                        onClick={() => setSelectedIds([])}>Clear</button>
                      <button className="btn sm" onClick={() => analyseBulk(selectedIds)}>
                        Analyse {selectedIds.length} record{selectedIds.length === 1 ? "" : "s"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div style={{ display: contracts.length ? "flex" : "none", justifyContent: "flex-end", marginTop: 12 }}>
              <a style={{ fontSize: 12.5, color: "#2F7BD9", cursor: "pointer", fontWeight: 700 }}
                 onClick={() => setSelectedIds(selectedIds.length === contracts.length ? [] : contracts.map((c) => c.id))}>
                {selectedIds.length === contracts.length ? "Deselect all" : "Select all for bulk analysis"}
              </a>
            </div>

            {(() => {
              const due = contracts.filter((c) => daysTo(c.endDate) != null && daysTo(c.endDate) >= 0 && daysTo(c.endDate) <= 180)
                .sort((a, b) => daysTo(a.endDate) - daysTo(b.endDate));
              return due.length ? (
                <div className="panel" style={{ marginBottom: 22 }}>
                  <h4>⏰ Renewal alert centre — action needed inside 180 days</h4>
                  {due.map((c) => (
                    <div className="item-row" key={c.id} style={{ marginTop: 10, marginBottom: 0 }}>
                      <div className={`sev ${daysTo(c.endDate) <= 90 ? "high" : "medium"}`} />
                      <div style={{ flex: 1 }}>
                        <b>{c.ref} · {c.supplier}{c.autoRenew ? " — auto-renews" : ""}</b>
                        <span>Ends {c.endDate} ({daysTo(c.endDate)} days) · notice period {c.noticePeriodDays || "?"} days{c.autoRenew && c.noticePeriodDays ? ` · serve notice by day ${daysTo(c.endDate) - c.noticePeriodDays >= 0 ? daysTo(c.endDate) - c.noticePeriodDays : 0}` : ""}</span>
                      </div>
                      <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); exportICS(c); }}>Add to calendar</button>
                      <button className="btn sm" onClick={() => { setSelectedId(c.id); setTab("Overview"); }}>Open</button>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}
            {contracts.length === 0 && (
              <div style={{ background: "#fff", border: "1px solid #E1EAF6", borderTop: "3px solid #2F7BD9",
                borderRadius: 10, padding: "34px 32px", boxShadow: "0 14px 36px rgba(15,43,76,0.07)" }}>
                <div style={{ maxWidth: 660 }}>
                  <h2 style={{ fontSize: 24, fontWeight: 700, color: "#0B1D33", marginBottom: 6 }}>
                    Your workspace is empty — let's change that.
                  </h2>
                  <p style={{ color: "#56718A", fontSize: 15, lineHeight: 1.6, marginBottom: 26 }}>
                    Start with the contract that worries you most. Usually that's the largest, or the one renewing soonest.
                  </p>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 18, marginBottom: 26 }}>
                  {[
                    ["1", "Create a record", "Enter the reference and supplier. That's the whole form — everything else is read from your documents."],
                    ["2", "Drop in the documents", "The agreement, purchase orders, SOWs, spreadsheets, and any Teams or Zoom transcripts about it."],
                    ["3", "Run the analysis", "Cost, risk, opportunities, compliance and the knowledge your team never wrote down."],
                  ].map(([n, h, p]) => (
                    <div key={n} style={{ display: "flex", gap: 13 }}>
                      <div style={{ width: 34, height: 39, flexShrink: 0, background: "linear-gradient(160deg,#2F7BD9,#5FA8F5)",
                        clipPath: "polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)", color: "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14 }}>{n}</div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14.5, color: "#16283E", marginBottom: 3 }}>{h}</div>
                        <div style={{ fontSize: 12.5, color: "#56718A", lineHeight: 1.55 }}>{p}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="btn" onClick={() => setShowNew(true)}>Create your first record</button>
                  <button className="btn ghost" onClick={() => csvRef.current?.click()}>Import a CSV</button>
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: "#7A8DA6" }}>Just looking around?</span>
                    <button className="btn ghost sm" onClick={loadSampleData}>Load a sample portfolio</button>
                  </div>
                </div>

                <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid #EEF3FA", fontSize: 12.5, color: "#7A8DA6", lineHeight: 1.6 }}>
                  Sample data is clearly fictional and can be wiped in one click from Settings. Nothing you upload leaves your machine until you run an analysis.
                </div>
              </div>
            )}

            <div className="grid">
              {contracts.map((c) => (
                <div key={c.id} className="card" onClick={() => { setSelectedId(c.id); setTab("Overview"); }}
                     style={selectedIds.includes(c.id) ? { border: "2px solid #2F7BD9", boxShadow: "0 12px 30px rgba(47,123,217,0.15)" } : undefined}>
                  <label onClick={(e) => e.stopPropagation()}
                    style={{ position: "absolute", top: 12, right: 12, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", zIndex: 2 }}
                    title="Select for bulk analysis">
                    <input type="checkbox" checked={selectedIds.includes(c.id)}
                      onChange={(e) => setSelectedIds((ids) => e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))}
                      style={{ width: 15, height: 15, accentColor: "#2F7BD9", cursor: "pointer" }} />
                  </label>
                  <div className="cat">{c.ref}{c.category ? ` · ${c.category}` : ""}</div>
                  <h3>{c.name || c.supplier}</h3>
                  <div className="sup">{c.supplier}</div>
                  <div className="meta">
                    <div>Annual value<b>{fmtMoney(c.annualValue, c.currency)}</b></div>
                    <div>Users<b>{c.users ? c.users.toLocaleString() : "—"}</b></div>
                    <div>Docs<b>{c.documents.length}</b></div>
                  </div>
                  {renewalPill(c)}
                  {c.analysis && <span className="pill blue" style={{ marginLeft: 6 }}>IQ {c.analysis.healthScore}/100</span>}
                  {c.analysis?.riskGrade && <span className={`pill ${["A", "B"].includes(c.analysis.riskGrade) ? "ok" : c.analysis.riskGrade === "C" ? "warn" : "risk"}`} style={{ marginLeft: 6 }}>Grade {c.analysis.riskGrade}</span>}
                </div>
              ))}
              <div className="add-card" onClick={() => setShowNew(true)}>
                <div className="plus">+</div>
                <div style={{ marginTop: 6, fontSize: 14, fontWeight: 500 }}>New Contract Record</div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="container">
          <div className="detail-head">
            <span className="back" onClick={() => setSelectedId(null)}>‹ Portfolio</span>
            <h1>{selected.name || selected.supplier}</h1>
            <div className="sub">{selected.ref} · {selected.supplier}{selected.category ? ` · ${selected.category}` : ""} · {fmtMoney(selected.annualValue, selected.currency)}/yr</div>
            <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {renewalPill(selected)}
              {selected.analysis?.riskGrade && <span className={`pill ${["A", "B"].includes(selected.analysis.riskGrade) ? "ok" : selected.analysis.riskGrade === "C" ? "warn" : "risk"}`}>Risk Grade {selected.analysis.riskGrade}</span>}
              {selected.analysis && openVerifications(selected.analysis).length > 0 && (
                <span className="pill risk" style={{ cursor: "pointer" }} onClick={() => setTab("Verify")}
                      title="Low-confidence data points need human verification before this record is relied upon">
                  {openVerifications(selected.analysis).length} to verify
                </span>
              )}
              {selected.analysis && openVerifications(selected.analysis).length === 0 && selected.analysis.dataPoints?.length > 0 && (
                <span className="pill ok" style={{ cursor: "pointer" }} onClick={() => setTab("Verify")}>Verified</span>
              )}
              {selected.autoRenew && <span className="pill warn">Auto-renews · {selected.noticePeriodDays || "?"}-day notice</span>}
                {(() => {
                  // Once documents are in and nothing has been analysed yet, this
                  // is the ONE thing the user should do next. Turning it red makes
                  // that unmissable, then it reverts to normal so a re-run does not
                  // keep shouting at somebody who has already done the job.
                  const readyToAnalyse = !selected.analysis
                    && (selected.documents || []).some((d) => d.text && !d.purged);
                  return (
                    <button className="btn sm" disabled={analyzing} onClick={analyse}
                      style={readyToAnalyse && !analyzing ? {
                        background: "#C0271D", borderColor: "#C0271D", color: "#fff",
                        boxShadow: "0 4px 14px rgba(192,39,29,0.32)",
                      } : undefined}
                      title={readyToAnalyse ? "Documents are ingested and ready — run the analysis" : undefined}>
                      {analyzing && <span className="spin" />}
                      {analyzing ? (
                        <>Analysing…&nbsp;
                          {/* Tabular figures and a fixed width: without these the
                              button resizes at 9%->10%->100% and shunts the
                              buttons beside it along the row. */}
                          <span style={{ fontVariantNumeric: "tabular-nums", display: "inline-block",
                            minWidth: "3.4ch", textAlign: "right" }}>
                            {analysisStage?.pct ?? 0}%
                          </span>
                        </>
                      ) : selected.analysis ? "Re-run AI analysis" : "Run AI analysis"}
                    </button>
                  );
                })()}
              {currentUser.role === "Admin" && (
                <button className="btn ghost sm" style={{ color: "#c0271d", borderColor: "rgba(192,39,29,0.4)" }} onClick={() => {
                  if (window.confirm(`Permanently delete ${selected.ref} (${selected.supplier}) and all its documents and analysis? This cannot be undone.`)) {
                    setContracts((cs) => cs.filter((c) => c.id !== selected.id));
                    setSelectedId(null);
                    notify("Contract Record and all associated data deleted");
                  }
                }}>Delete record</button>
              )}
            </div>

              {/* Progress. Analysis on a real contract takes 30-60 seconds;
                  a button that simply sits there for a minute reads as
                  broken. The bar is an elapsed-time estimate, not a reading
                  from the model, so it eases to 93% and waits rather than
                  pretending to finish early. */}
              {analyzing && analysisStage && (
                <div style={{ marginTop: 16, maxWidth: 560 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#16283E" }}>
                      {analysisStage.step ? `Step ${analysisStage.step} of ${analysisStage.of} · ` : ""}{analysisStage.label}…
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#2F7BD9",
                      fontVariantNumeric: "tabular-nums", minWidth: "3.4ch", textAlign: "right" }}>{analysisStage.pct}%</span>
                  </div>
                  <div style={{ height: 7, background: "#EEF3FA", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${analysisStage.pct}%`, borderRadius: 4,
                      background: "linear-gradient(90deg,#2F7BD9,#5FA8F5)", transition: "width .45s ease" }} />
                  </div>
                  <div style={{ fontSize: 11.5, color: "#7A8DA6", marginTop: 7 }}>
                    Reading {(selected.documents || []).filter((d) => d.text && !d.purged).length} document(s).
                    This usually takes 30 to 60 seconds — you can leave this page open.
                  </div>
                </div>
              )}

              {/* The reason a run failed, kept on screen. A toast disappears
                  before anyone has finished reading it. */}
              {/* Only one of these at a time. Showing a stale "partial" from an
                  earlier run next to a fresh error reads as two problems when
                  there is one. */}
              {!analyzing && !analysisError && selected.analysis?.partial?.length > 0 && (
                <div style={{ marginTop: 16, maxWidth: 700, background: "#FDF6E8",
                  border: "1px solid #EBD9AE", borderRadius: 8, padding: "13px 16px" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#8A5A0E", marginBottom: 5 }}>
                    Partial analysis — some sections are missing
                  </div>
                  <ul style={{ fontSize: 12.5, color: "#3D4F66", lineHeight: 1.6, margin: "0 0 10px 18px" }}>
                    {selected.analysis.partial.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                  <button className="btn sm" onClick={analyse}>Run the missing sections</button>
                </div>
              )}

              {!analyzing && analysisError && (
                <div style={{ marginTop: 16, maxWidth: 700, background: "#FDEEEC",
                  border: "1px solid #F0C4BF", borderRadius: 8, padding: "13px 16px" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#B23A31", marginBottom: 5 }}>
                    That analysis did not complete
                  </div>
                  <div style={{ fontSize: 12.5, color: "#3D4F66", lineHeight: 1.6 }}>{analysisError}</div>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button className="btn sm" onClick={analyse}>Try again</button>
                    <button className="btn ghost sm" onClick={() => setAnalysisError(null)}>Dismiss</button>
                  </div>
                </div>
              )}

              {creditBlock && (
                <div style={{ marginTop: 16, maxWidth: 700, background: "#FFF8E8",
                  border: "1px solid #F0DDB0", borderRadius: 8, padding: "13px 16px" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#8A6212", marginBottom: 5 }}>
                    {creditBlock.title}
                  </div>
                  <div style={{ fontSize: 12.5, color: "#3D4F66", lineHeight: 1.6 }}>{creditBlock.message}</div>
                  <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {creditBlock.canBuy && (
                      <button className="btn sm" disabled={topupBusy} onClick={() => buyCredits()}>
                        {topupBusy ? "Opening checkout…" : "Buy 100 credits"}
                      </button>
                    )}
                    <button className="btn ghost sm" onClick={() => { refreshEntitlement(); setCreditBlock(null); }}>
                      Refresh balance
                    </button>
                    <button className="btn ghost sm" onClick={() => setCreditBlock(null)}>Dismiss</button>
                  </div>
                </div>
              )}
          </div>

          <div className="seg">
            {TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
          </div>

          {tab === "Overview" && (
            <>
              <div className="panel">
                <h4>Record details {selected.analysis ? <span className="pill blue" style={{ marginTop: 0, marginLeft: 8 }}>Extracted from documents</span> : <span className="pill blue" style={{ marginTop: 0, marginLeft: 8 }}>Populates on ingestion + analysis</span>}</h4>
                <div className="kv">
                  <div><div className="k">Term</div><div className="x">{selected.startDate || "—"} → {selected.endDate || "—"}</div></div>
                  <div><div className="k">Notice period</div><div className="x">{selected.noticePeriodDays ? `${selected.noticePeriodDays} days` : "—"}</div></div>
                  <div><div className="k">Auto-renew</div><div className="x">{selected.autoRenew == null ? "—" : selected.autoRenew ? "Yes" : "No"}</div></div>
                  <div><div className="k">Users</div><div className="x">{selected.users != null ? selected.users.toLocaleString() : "—"}</div></div>
                  <div><div className="k">Owner</div><div className="x">{selected.owner || "—"}</div></div>
                  <div><div className="k">Documents</div><div className="x">{selected.documents.length}</div></div>
                </div>
                {selected.notes && <p style={{ marginTop: 14 }}><b>Notes:</b> {selected.notes}</p>}
              </div>
              {selected.analysis ? (
                <div className="panel">
                  <h4>Executive summary · Health score {selected.analysis.healthScore}/100</h4>
                  <p>{selected.analysis.execSummary}</p>
                </div>
              ) : (
                <div className="empty"><h3>No analysis yet</h3><p>Ingest this contract's documents, then run AI analysis — details, Cost, Users, Risk, Opportunities and Insights all populate from what's ingested.</p></div>
              )}
            </>
          )}

          {tab === "Verify" && (selected.analysis ? (() => {
            const dps = selected.analysis.dataPoints || [];
            const posture = accuracyPosture(selected.analysis);
            const groups = [
              { t: HIL_TIERS.deep,  items: dps.filter((d) => hilTier(d.confidence).key === "deep") },
              { t: HIL_TIERS.light, items: dps.filter((d) => hilTier(d.confidence).key === "light") },
              { t: HIL_TIERS.auto,  items: dps.filter((d) => hilTier(d.confidence).key === "auto") },
            ];
            return (
              <>
                <div className="panel">
                  <h3>Verification posture</h3>
                  {posture && (
                    <>
                      <div className="grid4" style={{ marginTop: 10 }}>
                        <div><div className="k">Data points</div><div className="x">{posture.total}</div></div>
                        <div><div className="k">Auto-accepted</div><div className="x" style={{ color: "#2E9E6B" }}>{posture.auto}</div></div>
                        <div><div className="k">Awaiting review</div><div className="x" style={{ color: posture.open ? "#E0493E" : "#2E9E6B" }}>{posture.open}</div></div>
                        <div><div className="k">Mean confidence</div><div className="x">{posture.meanConfidence}%</div></div>
                      </div>
                      <div style={{ height: 9, borderRadius: 5, overflow: "hidden", display: "flex", marginTop: 14, background: "#EEF3FA" }}>
                        <div style={{ width: `${(posture.auto / posture.total) * 100}%`, background: "#2E9E6B" }} />
                        <div style={{ width: `${(posture.cleared / posture.total) * 100}%`, background: "#5FA8F5" }} />
                        <div style={{ width: `${(posture.open / posture.total) * 100}%`, background: "#E0493E" }} />
                      </div>
                      <p style={{ fontSize: 12.5, color: "#56718A", marginTop: 10, lineHeight: 1.6 }}>
                        Confidence is the model's own estimate that a value is correct — it routes how much human attention a data point gets. It is <b>not</b> a measured accuracy rate.
                        A published accuracy figure requires benchmarking against a labelled gold-standard set; until that exists, treat these as triage signals rather than guarantees.
                      </p>
                    </>
                  )}
                </div>

                {groups.map(({ t, items }) => items.length === 0 ? null : (
                  <div className="panel" key={t.key}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: t.colour, display: "inline-block" }} />
                      {t.label} · {t.min}–{t.max}% confidence
                      <span className="pill" style={{ marginTop: 0, background: t.bg, color: t.colour }}>{items.length}</span>
                    </h3>
                    <p style={{ fontSize: 12.5, color: "#56718A", margin: "2px 0 12px" }}>{t.action}</p>
                    {items.map((d, i) => {
                      const done = d.status === "accepted" || d.status === "corrected";
                      return (
                        <div key={i} style={{ border: "1px solid #E1EAF6", borderLeft: `3px solid ${t.colour}`, borderRadius: 7, padding: "13px 15px", marginBottom: 9, background: done ? "#F7FBF9" : "#fff" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                            <div style={{ fontWeight: 700, fontSize: 14.5 }}>
                              {d.field}
                              <span style={{ fontWeight: 600, fontSize: 11.5, color: "#8FA3BC", marginLeft: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>{d.kind}</span>
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: t.colour }}>{d.confidence}%</div>
                          </div>
                          <div style={{ fontSize: 15, fontWeight: 600, margin: "5px 0 7px" }}>{String(d.value)}</div>
                          <div style={{ fontSize: 12.5, color: "#56718A", lineHeight: 1.55 }}>{d.reasoning}</div>
                          <div style={{ fontSize: 12, color: "#7A8DA6", marginTop: 6, fontStyle: "italic", lineHeight: 1.5 }}>
                            <b style={{ fontStyle: "normal" }}>Source:</b> {d.sourceRef}
                          </div>
                          {done ? (
                            <div style={{ fontSize: 12, color: "#2E9E6B", fontWeight: 700, marginTop: 9 }}>
                              ✓ {d.status === "corrected" ? "Corrected" : "Verified"} by {d.verifiedBy}{d.verifiedAt ? ` · ${new Date(d.verifiedAt).toLocaleString("en-GB")}` : ""}
                            </div>
                          ) : t.key === "auto" ? (
                            <div style={{ fontSize: 12, color: "#2E9E6B", fontWeight: 700, marginTop: 9 }}>✓ Auto-accepted — logged and reversible</div>
                          ) : (
                            <div style={{ display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap" }}>
                              <button className="btn sm" onClick={() => verifyPoint(d.field, "accepted")}>Accept as correct</button>
                              <button className="btn ghost sm" onClick={() => {
                                const v = window.prompt(`Correct value for "${d.field}":`, String(d.value ?? ""));
                                if (v !== null && v.trim() !== "") verifyPoint(d.field, "corrected", v.trim());
                              }}>Correct value</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {auditTrail.filter((a) => a.contractId === selected.id).length > 0 && (
                  <div className="panel">
                    <h3>Verification audit trail</h3>
                    <p style={{ fontSize: 12.5, color: "#56718A", margin: "2px 0 10px" }}>Every human decision on this record, in order. Exported with the report.</p>
                    {auditTrail.filter((a) => a.contractId === selected.id).map((a, i) => (
                      <div key={i} style={{ fontSize: 12.5, padding: "7px 0", borderBottom: "1px solid #EEF3FA", display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ color: "#7A8DA6", minWidth: 130 }}>{new Date(a.ts).toLocaleString("en-GB")}</span>
                        <span style={{ fontWeight: 700 }}>{a.user}</span>
                        <span style={{ color: a.action === "corrected" ? "#C98A1E" : "#2E9E6B", fontWeight: 700 }}>{a.action}</span>
                        <span>{a.field}</span>
                        {a.action === "corrected" && <span style={{ color: "#56718A" }}>“{String(a.from)}” → “{String(a.to)}”</span>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })() : (
            <div className="empty">
              <h3>Run AI analysis to populate the verification queue</h3>
              <p>Every extracted value, clause and risk is scored for confidence and routed for the right level of human review.</p>
            </div>
          ))}

          {tab === "Cost" && (selected.analysis ? (
            <>
              <div className="panel">
                <h4>Cost position <span className="save-tag" style={{ marginLeft: 10 }}>Est. saving {fmtMoney(selected.analysis.cost.estimatedAnnualSaving, selected.currency)}/yr</span></h4>
                <p>{selected.analysis.cost.summary}</p>
              </div>
              {selected.analysis.cost.breakdown.map((b, i) => (
                <div className="item-row" key={i}><div style={{ flex: 1 }}><b>{b.label}</b><span>{b.detail}</span></div></div>
              ))}
            </>
          ) : <div className="empty"><h3>Run AI analysis to see cost insights</h3></div>)}

          {tab === "Users" && (selected.analysis ? (
            <>
              <div className="panel"><h4>User & utilisation view</h4><p>{selected.analysis.users.summary}</p></div>
              {selected.analysis.users.points.map((p, i) => (
                <div className="item-row" key={i}><div className="sev low" /><div><span style={{ color: "#1d1d1f" }}>{p}</span></div></div>
              ))}
            </>
          ) : <div className="empty"><h3>Run AI analysis to see user insights</h3></div>)}

          {tab === "Risk" && (selected.analysis ? (
            selected.analysis.risks.map((r, i) => (
              <div className="item-row" key={i}>
                <div className={`sev ${r.severity}`} />
                <div style={{ flex: 1 }}><b>{r.title}</b><span>{r.detail}</span></div>
                <span className={`pill ${r.severity === "high" ? "risk" : r.severity === "medium" ? "warn" : "ok"}`} style={{ marginTop: 0 }}>{r.severity}</span>
              </div>
            ))
          ) : <div className="empty"><h3>Run AI analysis to see risks</h3></div>)}

          {tab === "Opportunities" && (selected.analysis ? (
            <>
              <div className="panel" style={{ padding: "16px 22px" }}>
                <p style={{ fontSize: 14 }}><b>{selected.analysis.opportunities.filter((o) => o.realised).length} of {selected.analysis.opportunities.length} realised.</b> Mark opportunities as realised when the saving lands — the executive digest tracks identified vs realised across the portfolio.</p>
              </div>
              {selected.analysis.opportunities.map((o, i) => (
                <div className="item-row" key={i}>
                  <div className={`sev ${o.realised ? "low" : "medium"}`} />
                  <div style={{ flex: 1 }}><b>{o.title}</b><span>{o.detail}</span></div>
                  <span className="save-tag">{o.savingEstimate}</span>
                  <button className={`btn sm ${o.realised ? "" : "ghost"}`} onClick={() => {
                    const ops = selected.analysis.opportunities.map((x, j) => j === i ? { ...x, realised: !x.realised } : x);
                    update(selected.id, { analysis: { ...selected.analysis, opportunities: ops } });
                  }}>{o.realised ? "Realised ✓" : "Mark realised"}</button>
                </div>
              ))}
            </>
          ) : <div className="empty"><h3>Run AI analysis to see opportunities</h3></div>)}

          {tab === "Compliance" && (selected.analysis?.compliance ? (
            <>
              <div className="panel">
                <h4>Legal & compliance position</h4>
                <p>{selected.analysis.compliance.summary}</p>
              </div>
              <div className="section-sub" style={{ marginBottom: 10, fontWeight: 600, color: "#56718a", fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em" }}>Clause checklist</div>
              {selected.analysis.compliance.clauses.map((c, i) => (
                <div className="item-row" key={i}>
                  <div className={`sev ${c.status === "present" ? "low" : c.status === "missing" ? "high" : "medium"}`} />
                  <div style={{ flex: 1 }}><b>{c.clause}</b><span>{c.note}</span></div>
                  <span className={`pill ${c.status === "present" ? "ok" : c.status === "missing" ? "risk" : "warn"}`} style={{ marginTop: 0 }}>{c.status}</span>
                </div>
              ))}
              {selected.analysis.compliance.regulatory?.length > 0 && (
                <div className="panel" style={{ marginTop: 16 }}>
                  <h4>Regulatory considerations</h4>
                  <ul>{selected.analysis.compliance.regulatory.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
              {selected.analysis.obligations?.length > 0 && (
                <>
                  <div className="section-sub" style={{ margin: "16px 0 10px", fontWeight: 600, color: "#56718a", fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em" }}>Obligations register</div>
                  {selected.analysis.obligations.map((o, i) => (
                    <div className="item-row" key={i}>
                      <span className="pill blue" style={{ marginTop: 2 }}>{o.owner === "us" ? "Ours" : "Supplier"}</span>
                      <div style={{ flex: 1 }}><b>{o.obligation}</b><span>Due: {o.due} · {o.note}</span></div>
                    </div>
                  ))}
                </>
              )}
              <p style={{ fontSize: 12, color: "#86868b", marginTop: 14, lineHeight: 1.5 }}>ContractIQ's compliance review is an AI-generated screening aid, not legal advice. Have qualified counsel confirm positions before signature or negotiation.</p>
            </>
          ) : <div className="empty"><h3>Run AI analysis to see the compliance review</h3><p>Clause checklist, regulatory flags and the obligations register are generated from ingested documents.</p></div>)}

          {tab === "Knowledge" && (selected.analysis ? (
            selected.analysis.knowledge ? (
              <>
                <div className="panel">
                  <h4>Institutional knowledge {selected.documents.some((d) => d.type === "Meeting transcript")
                    ? <span className="pill blue" style={{ marginTop: 0, marginLeft: 8 }}>From {selected.documents.filter((d) => d.type === "Meeting transcript").length} transcript(s)</span>
                    : <span className="pill warn" style={{ marginTop: 0, marginLeft: 8 }}>No transcripts ingested</span>}</h4>
                  <p>{selected.analysis.knowledge.summary}</p>
                </div>

                {selected.analysis.knowledge.points?.length > 0 && (
                  <>
                    <div className="section-sub" style={{ margin: "16px 0 10px", fontWeight: 700, color: "#56718A", fontSize: 12.5, textTransform: "uppercase", letterSpacing: "0.1em" }}>What the meetings tell us</div>
                    {selected.analysis.knowledge.points.map((k, i) => (
                      <div className="item-row" key={i}>
                        <div className="sev low" />
                        <div style={{ flex: 1 }}>
                          <b>{k.insight}</b>
                          <span>{k.matters}</span>
                          <span style={{ marginTop: 4, fontStyle: "italic", color: "#7B8CA3" }}>Source: {k.source}</span>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {selected.analysis.knowledge.verbalCommitments?.length > 0 && (
                  <>
                    <div className="section-sub" style={{ margin: "18px 0 10px", fontWeight: 700, color: "#56718A", fontSize: 12.5, textTransform: "uppercase", letterSpacing: "0.1em" }}>Said in a meeting — is it in the contract?</div>
                    {selected.analysis.knowledge.verbalCommitments.map((v, i) => (
                      <div className="item-row" key={i}>
                        <div className={`sev ${v.inContract === "yes" ? "low" : v.inContract === "no" ? "high" : "medium"}`} />
                        <div style={{ flex: 1 }}>
                          <b>{v.commitment}</b>
                          <span>Said by {v.saidBy} · {v.action}</span>
                        </div>
                        <span className={`pill ${v.inContract === "yes" ? "ok" : v.inContract === "no" ? "risk" : "warn"}`} style={{ marginTop: 0 }}>
                          {v.inContract === "yes" ? "In contract" : v.inContract === "no" ? "Not in contract" : "Unclear"}
                        </span>
                      </div>
                    ))}
                  </>
                )}

                {selected.analysis.knowledge.keyPersonRisk?.length > 0 && (
                  <div className="panel" style={{ borderLeftColor: "#E0493E", marginTop: 18 }}>
                    <h4>Knowledge at risk of walking out of the door</h4>
                    <ul>{selected.analysis.knowledge.keyPersonRisk.map((k, i) => <li key={i}>{k}</li>)}</ul>
                  </div>
                )}

                {selected.analysis.knowledge.openQuestions?.length > 0 && (
                  <div className="panel">
                    <h4>Ask while you still can</h4>
                    <ul>{selected.analysis.knowledge.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
                  </div>
                )}

                <p style={{ fontSize: 12, color: "#7B8CA3", marginTop: 14, lineHeight: 1.55 }}>
                  Meeting content is reported context, not contractual terms. Anything relied upon commercially should be confirmed in writing with the supplier.
                </p>
              </>
            ) : <div className="empty"><h3>No knowledge captured yet</h3><p>Ingest a Teams or Zoom transcript into this record and re-run the analysis.</p></div>
          ) : <div className="empty"><h3>Run AI analysis to capture institutional knowledge</h3><p>Add meeting transcripts to this record first — the context they hold is often nowhere in the contract itself.</p></div>)}

          {tab === "Insights" && (selected.analysis ? (
            <>
              <div className="panel"><h4>Negotiation levers</h4><ul>{selected.analysis.insights.negotiationLevers.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
              <div className="panel"><h4>Recommendations</h4><ul>{selected.analysis.insights.recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
              <div className="panel"><h4>Dates to watch</h4><ul>{selected.analysis.insights.watchDates.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
              <div className="export-bar" style={{ marginTop: 8 }}>
                <span style={{ fontSize: 13, color: "#56718a", fontWeight: 700 }}>EXPORT INSIGHT PACK</span>
                <button className="btn ghost sm" onClick={() => exportWord(selected)}>Word (.doc)</button>
                <button className="btn ghost sm" onClick={() => exportPDF(selected)}>PDF</button>
                <button className="btn ghost sm" onClick={() => exportPPT(selected)}>PPT outline</button>
              </div>
            </>
          ) : <div className="empty"><h3>Run AI analysis to unlock insights & exports</h3></div>)}

          {tab === "Documents" && (
            <>
              <div className="doc-drop" onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); onFiles([...e.dataTransfer.files]); }}>
                <div style={{ fontSize: 30 }}>⌥</div>
                <div style={{ fontWeight: 700, color: "#0B1D33", marginTop: 6 }}>Drop this contract's documents and meeting transcripts here, or click to browse</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>Contracts · Purchase Orders · SOWs · tracking sheets · user detail · Teams and Zoom meeting transcripts (.vtt, .srt, .txt, .docx). All record details are extracted from what you ingest — PDFs, Excel, CSV and text are read in full in-browser (nothing leaves your machine until you run analysis). Scanned/image-only PDFs are catalogued by metadata.</div>
              </div>
              <input type="file" multiple hidden ref={fileRef} onChange={(e) => { onFiles([...e.target.files]); e.target.value = ""; }} />
              <p style={{ fontSize: 12, color: "#7B8CA3", marginTop: 10, lineHeight: 1.55 }}>
                <b>Transcripts:</b> meeting recordings contain participants' personal data, so only upload transcripts of meetings your organisation had a lawful basis to record, and tell participants the record may be retained against the contract. Zero-Retention mode purges transcript text after analysis, keeping only the extracted knowledge.
              </p>
              {selected.documents.map((d) => (
                <div className="doc-item" key={d.id} style={d.scanned ? { borderLeft: "3px solid #EE9420", background: "#FFFBF4" } : undefined}>
                  <div style={{ flex: 1 }}>
                    <span className="nm">{d.name}</span>
                    <span className="tp">{d.type} · {(d.size / 1024).toFixed(0)} KB{d.pageCount ? ` · ${d.pageCount}pp` : ""} {d.purged ? "· text purged (Zero-Retention)" : d.scanned ? "· scanned image — no text layer" : d.ocr ? `· text recovered by OCR (${d.ocr.chars.toLocaleString()} chars)` : d.text ? "· content ingested" : "· metadata only"}{d.uploadedBy ? ` · by ${d.uploadedBy}` : ""}</span>
                    {d.consent && <span className="tp" style={{ color: "#2E9E6B" }}>✓ recording consent accepted by {d.consent.by} on {new Date(d.consent.at).toLocaleDateString("en-GB")}</span>}
                    {d.scanned && (
                      <div style={{ marginTop: 8 }}>
                        {ocrBusy?.docId === d.id ? (
                          <div style={{ fontSize: 12.5, color: "#C98A1E", fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="spin" />Reading page {ocrBusy.page || 1}{ocrBusy.total ? ` of ${ocrBusy.total}` : ""}…
                          </div>
                        ) : (
                          <>
                            <button className="btn sm" onClick={() => ocrDocument(d.id)}>Run OCR to read this document</button>
                            <span style={{ fontSize: 11.5, color: "#86868b", marginLeft: 10 }}>Runs in your browser — the document is not sent anywhere.</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <a onClick={() => update(selected.id, { documents: selected.documents.filter((x) => x.id !== d.id) })}>Remove</a>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── Ask Cedric ── */}
      {!cedricOpen && (
        <button className="cedric-fab" onClick={() => setCedricOpen(true)}>✦ Ask Cedric</button>
      )}

      {/* ── Background job tray ───────────────────────────────
          Queued work is invisible by definition, so it needs somewhere
          to be seen. Only appears when something is actually running. */}
      {activeJobs.length > 0 && (
        <div style={{ position: "fixed", bottom: 18, right: 18, zIndex: 900, width: 340,
          background: "#fff", border: "1px solid #D6E3F5", borderRadius: 10,
          boxShadow: "0 18px 44px rgba(15,43,76,0.18)", overflow: "hidden" }}>
          <div style={{ background: "#0F2B4C", color: "#fff", padding: "10px 14px",
            display: "flex", alignItems: "center", gap: 9, fontSize: 13, fontWeight: 700 }}>
            {activeJobs.some((j) => j.status !== "dead") && <span className="spin" />}
            Background analysis
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#A9CFF6", fontWeight: 600 }}>
              {activeJobs.filter((j) => j.status !== "dead").length} running
            </span>
          </div>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {activeJobs.map((j) => (
              <div key={j.id} style={{ padding: "11px 14px", borderBottom: "1px solid #EEF3FA" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "#16283E" }}>
                    {j.ref || j.contract_id}{j.supplier ? ` · ${j.supplier}` : ""}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700,
                    color: j.status === "dead" ? "#B23A31" : j.status === "running" ? "#2F7BD9" : "#7A8DA6" }}>
                    {j.status === "dead" ? "Failed" : j.status === "running" ? `${j.progress || 0}%` : "Queued"}
                  </span>
                </div>
                {j.status !== "dead" && (
                  <div style={{ height: 4, background: "#EEF3FA", borderRadius: 2, overflow: "hidden", marginTop: 7 }}>
                    <div style={{ height: "100%", width: `${j.status === "running" ? (j.progress || 5) : 2}%`,
                      background: "#2F7BD9", transition: "width .4s" }} />
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: j.status === "dead" ? "#B23A31" : "#7A8DA6", marginTop: 5 }}>
                  {j.status === "dead"
                    ? (j.error ? String(j.error).slice(0, 80) : "Failed after several attempts")
                    : (j.progress_note || "Waiting for a worker…")}
                  {j.attempts > 1 && j.status !== "dead" && ` · attempt ${j.attempts}`}
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: "9px 14px", fontSize: 11.5, color: "#7A8DA6", background: "#F7FAFE" }}>
            You can close this tab — the work carries on without you.
          </div>
        </div>
      )}

      {/* ── Portfolio-wide search results ────────────────────── */}
      {search.trim().length >= 2 && (() => {
        const results = searchPortfolio(contracts, search);
        const hits = results.reduce((s, r) => s + r.total, 0);
        return (
          <div className="modal-bg" onClick={() => setSearch("")} style={{ alignItems: "flex-start", paddingTop: 70 }}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, maxHeight: "78vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 20 }}>
                  {hits === 0 ? "No matches" : `${hits} match${hits === 1 ? "" : "es"} in ${results.length} contract${results.length === 1 ? "" : "s"}`}
                </h2>
                <a style={{ fontSize: 12.5, color: "#2F7BD9", cursor: "pointer", fontWeight: 700 }} onClick={() => setSearch("")}>Close</a>
              </div>
              <div className="mh" style={{ marginTop: 4, marginBottom: 14 }}>
                Searching record details, ingested document text, and every analysis finding for “{search}”.
              </div>
              {hits === 0 ? (
                <div style={{ fontSize: 13.5, color: "#56718A", lineHeight: 1.6 }}>
                  Nothing found. Documents are only searchable once their text has been ingested — a scanned PDF needs OCR running first.
                </div>
              ) : results.map(({ contract, hits: hl, total }) => (
                <div key={contract.id} style={{ border: "1px solid #E1EAF6", borderRadius: 7, padding: "13px 15px", marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <a style={{ fontWeight: 700, fontSize: 15, color: "#2F7BD9", cursor: "pointer" }}
                       onClick={() => { setSelectedId(contract.id); setPage("portfolio"); setTab("Overview"); setSearch(""); }}>
                      {contract.ref} · {contract.supplier}
                    </a>
                    <span style={{ fontSize: 12, color: "#7A8DA6" }}>{total} match{total === 1 ? "" : "es"}</span>
                  </div>
                  {hl.map((h, i) => (
                    <div key={i} style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid #DDE9F8" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#8FA3BC", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h.where}</div>
                      <div style={{ fontSize: 12.5, color: "#3D4F66", lineHeight: 1.55, marginTop: 2 }}>{h.text}</div>
                    </div>
                  ))}
                  {total > hl.length && <div style={{ fontSize: 12, color: "#7A8DA6", marginTop: 8 }}>+{total - hl.length} more in this contract</div>}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Transcript recording-consent gate ────────────────────
          Blocks the upload until the obligation is explicitly accepted.
          The acceptance is stored and stamped onto every transcript. */}
      {consentPrompt && (
        <div className="modal-bg" onClick={() => setConsentPrompt(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <div style={{ display: "flex", gap: 13, alignItems: "flex-start" }}>
              <div style={{ width: 40, height: 46, flexShrink: 0, background: "linear-gradient(160deg,#EE9420,#C98A1E)",
                clipPath: "polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)", display: "flex", alignItems: "center",
                justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 20 }}>!</div>
              <div>
                <h2 style={{ margin: 0, fontSize: 21 }}>Before you upload this transcript</h2>
                <div className="mh" style={{ marginTop: 4 }}>Meeting recordings contain other people's personal data.</div>
              </div>
            </div>

            <div style={{ background: "#FDF3E3", borderLeft: "4px solid #C98A1E", borderRadius: 6, padding: "14px 16px", margin: "16px 0" }}>
              <div style={{ fontSize: 13, color: "#6B4E1C", lineHeight: 1.65 }}>
                By continuing you confirm that, for {consentPrompt.transcriptNames.length === 1 ? "this recording" : "these recordings"}, your organisation:
                <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
                  <li>had a <b>lawful basis</b> to make and retain it;</li>
                  <li><b>informed all participants in advance</b> that the meeting was being recorded or transcribed, and that the record may be retained and processed against this contract;</li>
                  <li>obtained <b>any consent required</b> under applicable data-protection law.</li>
                </ul>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#56718A", marginBottom: 12 }}>
              <b>File{consentPrompt.transcriptNames.length > 1 ? "s" : ""}:</b>{" "}
              {consentPrompt.transcriptNames.join(", ")}
            </div>

            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer",
              border: "1.5px solid " + (consentTicked ? "#2F7BD9" : "#D6E3F5"), borderRadius: 7, padding: "12px 14px",
              background: consentTicked ? "#F5F9FE" : "#fff", transition: "all .15s" }}>
              <input type="checkbox" checked={consentTicked} onChange={(e) => setConsentTicked(e.target.checked)}
                style={{ marginTop: 2, width: 16, height: 16, accentColor: "#2F7BD9", flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, lineHeight: 1.55, fontWeight: 600 }}>
                Yes, I accept — I confirm the above and accept the{" "}
                <a onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSettingsLegal("terms"); }} href="#"
                   style={{ color: "#2F7BD9" }}>Terms of Use</a> and{" "}
                <a onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSettingsLegal("dpa"); }} href="#"
                   style={{ color: "#2F7BD9" }}>Data Processing Agreement</a>.
              </span>
            </label>

            <div style={{ fontSize: 11.5, color: "#86868b", marginTop: 10, lineHeight: 1.5 }}>
              Your acceptance is recorded against your name and the date, and referenced by every transcript you upload.
              You will not be asked again unless the terms change.
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button className="btn ghost" onClick={() => setConsentPrompt(null)}>Cancel upload</button>
              <button className="btn" disabled={!consentTicked} onClick={acceptTranscriptConsent}
                style={{ opacity: consentTicked ? 1 : 0.45, cursor: consentTicked ? "pointer" : "not-allowed" }}>
                Accept and upload
              </button>
            </div>
          </div>
        </div>
      )}
      {cedricOpen && (
        <div className="cedric">
          <div className="cedric-head">
            <div>
              <b>✦ Cedric</b>
              <div className="sc">{selected ? `Scope: ${selected.ref} · ${selected.supplier}` : "Name a contract (ref, name or supplier) to begin"}</div>
            </div>
            <button onClick={() => setCedricOpen(false)}>✕</button>
          </div>
          <div className="cedric-msgs">
            {cedricMsgs.length === 0 && (
              <div className="cmsg bot">Hello {currentUser.displayName.split(" ")[0]} — I'm Cedric. To keep answers accurate, I only recall a contract you name: include its ref, name or supplier in your question{selected ? " (this open record counts, so ask away)" : ""}. Costs, renewal dates, risks, missing clauses, what to push for in negotiation — I answer only from what's been ingested and analysed.</div>
            )}
            {cedricMsgs.map((m, i) => <div key={i} className={`cmsg ${m.role === "user" ? "user" : "bot"}`}>{m.text}</div>)}
            {cedricBusy && <div className="cmsg bot"><span className="spin b" style={{ marginRight: 8 }} />Thinking…</div>}
            <div ref={cedricEnd} />
          </div>
            {/* A question was chosen from the library with no contract open.
                Rather than losing it, hold it and ask which contract to use. */}
            {pendingAction && !selected && (
              <div style={{ padding: "12px 14px", borderTop: "1px solid #E1EAF6", background: "#F7FAFE" }}>
                <div style={{ fontSize: 12.5, color: "#3D4F66", marginBottom: 4 }}>Which contract should I look at for</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1D33", marginBottom: 10 }}>
                  &ldquo;{pendingAction.title}&rdquo;?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 190, overflowY: "auto" }}>
                  {contracts.slice(0, 12).map((c) => (
                    <button key={c.id} className="btn ghost sm"
                      style={{ textAlign: "left", justifyContent: "flex-start" }}
                      onClick={() => {
                        const q = pendingAction.prompt;
                        setPendingAction(null);
                        setSelectedId(c.id);
                        setPage("portfolio");
                        sendCedric(q, c);
                      }}>
                      {c.ref} · {c.supplier}
                    </button>
                  ))}
                </div>
                <button className="btn ghost sm" style={{ marginTop: 8 }}
                  onClick={() => setPendingAction(null)}>Cancel</button>
              </div>
            )}

          {cedricMsgs.length === 0 && !pendingAction && (
            <div className="cedric-sugs">
              {(selected
                ? ["When does this contract renew?", "Biggest saving opportunity?", "What are the high risks?"]
                : contracts.slice(0, 3).map((c) => `What's the position on ${c.ref}?`)
              ).map((s) => <button key={s} onClick={() => sendCedric(s)}>{s}</button>)}
            </div>
          )}
            {voiceNote && (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "#8A5A0E",
                background: "#FDF6E8", borderTop: "1px solid #EBD9AE" }}>{voiceNote}</div>
            )}
            <div className="cedric-input">
              <input value={cedricInput} onChange={(e) => setCedricInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendCedric()}
                placeholder={listening ? "Listening… speak now" : "Ask Cedric anything about a contract…"} />
              <button type="button" onClick={toggleVoice} disabled={cedricBusy}
                aria-label={listening ? "Stop listening" : "Ask by voice"}
                title={listening ? "Stop listening" : "Ask by voice"}
                style={{ width: 38, height: 38, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                  border: "1.5px solid " + (listening ? "#E0493E" : "#D6E3F5"),
                  background: listening ? "#FDEEEC" : "#fff",
                  color: listening ? "#E0493E" : "#7A8DA6",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  animation: listening ? "ciqpulse 1.3s ease-in-out infinite" : "none" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 19v3" />
                </svg>
              </button>
              <button className="btn sm" disabled={cedricBusy} onClick={() => sendCedric()}>Send</button>
            </div>
        </div>
      )}

      {/* ── New Contract Record ── */}
      {showNew && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setShowNew(false)}>
          <div className="modal" style={{ width: 460 }}>
            <h2>New Contract Record</h2>
            <div className="mh">Just two details to start — everything else (value, term, dates, users, category) is extracted automatically when you ingest the contract's documents and run analysis.</div>
            <div className="fld"><label>Contract Ref</label>
              <input value={form.ref} onChange={(e) => setForm((p) => ({ ...p, ref: e.target.value }))} placeholder="e.g. CTR-0004" autoFocus /></div>
            <div className="fld"><label>Supplier</label>
              <input value={form.supplier} onChange={(e) => setForm((p) => ({ ...p, supplier: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && createRecord()} placeholder="e.g. Microsoft" /></div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn ghost" onClick={() => setShowNew(false)}>Cancel</button>
              <button className="btn" onClick={createRecord}>Create record</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings: Supabase + Team ── */}
      {showSettings && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setShowSettings(false)}>
          <div className="modal" style={{ width: 560 }}>
            <h2>Settings</h2>
            <div className="mh">Your edition, workspace connection and business-account users.</div>

            <div style={{ background: "#F5F9FE", borderLeft: "4px solid #2F7BD9", borderRadius: 6, padding: "18px 20px", marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <b style={{ fontSize: 16, color: "#0B1D33" }}>{ED.name}</b>
                <span className="pill blue" style={{ marginTop: 0 }}>{ED.price}</span>
              </div>
              <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700, color: "#56718A", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Credit balance
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
                {creditsUsed} of {creditsIncluded.toLocaleString()} used {ED.windowLabel} · {creditsLeft.toLocaleString()} remaining
              </div>
              <div style={{ height: 7, background: "#DDE9F8", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, (creditsUsed / creditsIncluded) * 100)}%`, background: creditsLeft === 0 ? "#E0493E" : creditsLeft < creditsIncluded * 0.15 ? "#EE9420" : "#2F7BD9" }} />
              </div>
              <div style={{ fontSize: 12, color: "#56718A", marginTop: 8 }}>
                That is about <b>{analysesLeft}</b> more analyses, or <b>{Math.floor(creditsLeft / CREDIT_COST.cedric)}</b> more questions to Cedric.
                An analysis costs {CREDIT_COST.analysis} credits, a question costs {CREDIT_COST.cedric}, and re-running an analysis inside the revision window is free.
              </div>

              {/* Bought credits are a separate bucket that does not reset,
                  and plan credits are always spent first. Saying so stops
                  the "where did my top-up go?" support email. */}
              {boltonLeft > 0 && (
                <div style={{ fontSize: 12, color: "#1E7A4B", marginTop: 6 }}>
                  Includes <b>{boltonLeft.toLocaleString()}</b> bought credits, which do not expire when the month rolls over.
                  Your plan allowance is always spent first.
                </div>
              )}
              {creditsHeld > 0 && (
                <div style={{ fontSize: 12, color: "#8A6212", marginTop: 6 }}>
                  <b>{creditsHeld}</b> reserved by analysis currently running. Reserved credits are returned if the run fails.
                </div>
              )}

              {session && !DEMO_MODE && (
                <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button className="btn sm" disabled={topupBusy} onClick={() => buyCredits()}>
                    {topupBusy ? "Opening checkout…" : "Buy 100 credits — £25"}
                  </button>
                  <button className="btn ghost sm" onClick={() => refreshEntitlement()}>Refresh balance</button>
                </div>
              )}

              {entitlementError && (
                <div style={{ marginTop: 12, fontSize: 12.5, color: "#B23A31", background: "#FDEEEC",
                  border: "1px solid #F0C4BF", borderRadius: 6, padding: "9px 12px" }}>
                  {entitlementError}
                </div>
              )}
              <ul style={{ margin: "14px 0 0", paddingLeft: 18, fontSize: 13.5, color: "#3D4F66", lineHeight: 1.7 }}>
                {ED.features.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
              {EDITION !== "enterprise" && (
                <p style={{ fontSize: 12.5, color: "#56718A", marginTop: 12 }}>
                  Need more? {EDITION === "sandbox" ? "Growth adds 15 audits a month, custom playbooks and advanced cross-clause logic." : "Enterprise adds custom volume, Zero-Retention, dedicated API keys and corporate SSO."}
                </p>
              )}
            </div>
              {/* When the deployment is pre-configured, a customer has no
                  business seeing a connection form — it is our plumbing,
                  not their setting. Show a quiet confirmation instead and
                  keep the editable fields for local testing only. */}
              {SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? (
                <div style={{ background: "#EFF8F3", border: "1px solid #BFE3D0", borderRadius: 8,
                  padding: "12px 15px", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2E9E6B" }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1F7A52" }}>AI analysis connected</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "#3D4F66", marginTop: 6, lineHeight: 1.55 }}>
                    Nothing to configure. Analysis and Cedric are ready to use.
                  </div>
                </div>
              ) : (
                <>
                  <div className="fld"><label>Supabase project URL</label>
                    <input value={sb.url}
                      onChange={(e) => setSb((p) => ({ ...p, url: e.target.value }))}
                      onBlur={(e) => setSb((p) => ({ ...p, url: e.target.value.trim().replace(/\/+$/, "") }))}
                      placeholder="https://xxxx.supabase.co" /></div>
                  <div className="fld"><label>Publishable key <span style={{ color: "#8FA3BC", fontWeight: 400 }}>(or legacy anon key)</span></label>
                    <input value={sb.key} onChange={(e) => setSb((p) => ({ ...p, key: e.target.value }))}
                      placeholder="sb_publishable_…" /></div>
                  {sb.key && sb.key.startsWith("sb_secret_") && (
                    <div style={{ background: "#FDEEEC", border: "1px solid #F0C4BF", color: "#B23A31",
                      borderRadius: 7, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
                      <b>That is a secret key.</b> It bypasses every security rule on your database and must
                      never go in a browser. Use the <b>publishable</b> key, and revoke that secret key now.
                    </div>
                  )}
                </>
              )}
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button className="btn ghost sm" disabled title="Needs a signed-in account"
                  style={{ opacity: 0.45, cursor: "not-allowed" }}>Sync to Supabase ↑</button>
                <button className="btn ghost sm" disabled title="Needs a signed-in account"
                  style={{ opacity: 0.45, cursor: "not-allowed" }}>Load from Supabase ↓</button>
              </div>
              {/* These fail structurally, not because of a wrong key: contracts.account_id
                  is NOT NULL and row-level security scopes every write to the signed-in
                  user's workspace. Until sign-in moves to Supabase Auth there is no
                  account to write into. Better to say so than to throw an error. */}
              <div style={{ background: "#F5F9FE", border: "1px solid #C8DCF5", color: "#3D4F66",
                borderRadius: 7, padding: "10px 13px", fontSize: 12.5, lineHeight: 1.6, marginBottom: 16 }}>
                <b>Sync is not switched on yet.</b> Saving contracts to the cloud needs a real signed-in
                account, which arrives with Supabase Auth. Your work lives in this browser for now.
                <br /><br />
                <b>You do not need it for AI analysis.</b> The URL and key above are what the app uses to
                reach your AI function — that works on its own.
              </div>

            <h2 style={{ fontSize: 18, marginTop: 4 }}>Playbook Playground</h2>
            {ED.playbook ? (
              <>
                <div className="mh" style={{ marginBottom: 10 }}>Your organisation's own vetting rules. Every analysis grades contracts against these positions — deviations lower the health score and risk grade.</div>
                <div className="fld">
                  <textarea rows={4} value={playbook} onChange={(e) => setPlaybook(e.target.value)}
                    placeholder={"One rule per line, e.g.\nLiability cap must be at least 12 months' fees\nNo auto-renewal without 120-day notice\nPayment terms 60 days minimum\nUplifts capped at CPI or 3%"} />
                </div>
              </>
            ) : (
              <div className="locked">
                <div>
                  <b>Custom playbook configuration</b>
                  <span>Grade every contract against your own standard positions, so non-standard liability caps or payment terms are flagged automatically.</span>
                </div>
                <span className="pill blue" style={{ marginTop: 0 }}>Growth</span>
              </div>
            )}

            <h2 style={{ fontSize: 18, marginTop: 18 }}>Data handling</h2>
            {ED.zeroRetention ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#F5F9FE", borderRadius: 6, padding: "14px 16px", marginBottom: 16, borderLeft: "4px solid #2F7BD9" }}>
                <div>
                  <b style={{ fontSize: 14 }}>Zero-Retention mode</b>
                  <div style={{ fontSize: 12, color: "#56718a", marginTop: 2 }}>Purge document text immediately after each analysis — only extracted details and metadata are kept.</div>
                </div>
                <button className={`btn sm ${zeroRetention ? "" : "ghost"}`} onClick={() => { setZeroRetention(!zeroRetention); notify(!zeroRetention ? "Zero-Retention enabled" : "Zero-Retention disabled"); }}>{zeroRetention ? "On" : "Off"}</button>
              </div>
            ) : (
              <div className="locked">
                <div>
                  <b>Zero-Retention processing</b>
                  <span>Hold documents in memory only — source text is expunged the moment analysis completes, leaving just the extracted schema.</span>
                </div>
                <span className="pill blue" style={{ marginTop: 0 }}>Enterprise</span>
              </div>
            )}

            {ED.apiKeys && (
              <div style={{ background: "#F5F9FE", borderRadius: 6, padding: "16px 18px", marginBottom: 14, borderLeft: "4px solid #2F7BD9" }}>
                <b style={{ fontSize: 14 }}>Dedicated API access key</b>
                <div style={{ fontSize: 12, color: "#56718a", margin: "3px 0 10px" }}>Programmatic access for your own pipelines. Treat it like a password — it carries your account's full permissions.</div>
                {apiKey ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <code style={{ fontFamily: "monospace", fontSize: 12.5, background: "#0B1D33", color: "#A9CFF6", padding: "8px 12px", borderRadius: 6, wordBreak: "break-all" }}>{apiKey}</code>
                    <button className="btn ghost sm" onClick={() => { setApiKey(null); notify("Key revoked"); }}>Revoke</button>
                  </div>
                ) : (
                  <button className="btn ghost sm" onClick={() => {
                    const b = new Uint8Array(24); crypto.getRandomValues(b);
                    setApiKey("ciq_live_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
                    notify("API key generated — copy it now, it is shown once");
                  }}>Generate key</button>
                )}
              </div>
            )}

            {ED.sso && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#F5F9FE", borderRadius: 6, padding: "14px 16px", marginBottom: 16, borderLeft: "4px solid #2F7BD9" }}>
                <div>
                  <b style={{ fontSize: 14 }}>Corporate SSO</b>
                  <div style={{ fontSize: 12, color: "#56718a", marginTop: 2 }}>Route sign-in through your identity provider (SAML / OIDC). Configured with your onboarding engineer.</div>
                </div>
                <button className={`btn sm ${ssoEnabled ? "" : "ghost"}`} onClick={() => { setSsoEnabled(!ssoEnabled); notify(!ssoEnabled ? "SSO enforcement requested — onboarding will confirm" : "SSO enforcement disabled"); }}>{ssoEnabled ? "On" : "Off"}</button>
              </div>
            )}

            {currentUser.role === "Admin" && (
              <>
                <h2 style={{ fontSize: 18, marginTop: 20 }}>Team on this account</h2>
                {accountUsers.map((u) => (
                  <div className="doc-item" key={u.username}>
                    <div><span className="nm">{u.displayName}</span><span className="tp">@{u.username} · {u.role}</span></div>
                    {u.username !== currentUser.username && u.role !== "Admin" && (
                      <a onClick={() => setAccountUsers((us) => us.filter((x) => x.username !== u.username))}>Remove</a>
                    )}
                  </div>
                ))}
                <div className="frow" style={{ marginTop: 14 }}>
                  <div className="fld"><label>Display name</label><input value={newUser.displayName} onChange={(e) => setNewUser((p) => ({ ...p, displayName: e.target.value }))} placeholder="Full name" /></div>
                  <div className="fld"><label>Username</label><input value={newUser.username} onChange={(e) => setNewUser((p) => ({ ...p, username: e.target.value }))} placeholder="username" /></div>
                </div>
                <div className="frow">
                  <div className="fld"><label>Password</label><input value={newUser.password} onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))} placeholder="Temporary password" /></div>
                  <div className="fld"><label>&nbsp;</label><button className="btn ghost" style={{ width: "100%" }} onClick={addTeamUser}>Add user</button></div>
                </div>
                <p style={{ fontSize: 12, color: "#56718a", lineHeight: 1.5 }}>Preview build stores users in-session only. The production build uses Supabase Auth — passwords are hashed and managed by Supabase, never stored in the app.</p>
              </>
            )}
            <h2 style={{ fontSize: 18, marginTop: 20 }}>Workspace data</h2>
            <div className="mh" style={{ marginBottom: 10 }}>
              {contracts.length === 0
                ? "Your workspace is empty. Load a sample portfolio to explore or demonstrate the product — it is clearly fictional and wipes in one click."
                : `${contracts.length} contract record${contracts.length === 1 ? "" : "s"} in this workspace.`}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn ghost sm" onClick={loadSampleData}>Load sample portfolio</button>
              <button className="btn ghost sm" style={{ color: "#B23A31", borderColor: "rgba(178,58,49,0.4)" }}
                onClick={() => { if (window.confirm("Clear every contract record, document, analysis and tracking entry in this workspace? This cannot be undone.")) clearAllData(); }}>
                Clear all data
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: "#86868b", marginTop: 8, lineHeight: 1.5 }}>
              Clearing removes contracts, documents, analyses, credit history, obligation tracking and the audit trail. Your sign-in and settings are kept.
            </p>

            <h2 style={{ fontSize: 18, marginTop: 20 }}>Regulatory policy packs</h2>
            <div className="mh" style={{ marginBottom: 10 }}>
              Compliance rules are configuration, not code. Toggle a pack on or off and the next analysis grades against the new rule set — no redeployment, no release.
              In production these live in the <code style={{ fontSize: 12 }}>policy_packs</code> table so a regulatory change is a database update.
            </div>
            {policyPacks.map((p, i) => (
              <div key={p.id} style={{ border: "1px solid #E1EAF6", borderRadius: 7, padding: "11px 13px", marginBottom: 8, background: p.active ? "#F5F9FE" : "#FAFBFD" }}>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                  <input type="checkbox" checked={p.active} style={{ marginTop: 3, accentColor: "#2F7BD9" }}
                    onChange={(e) => setPolicyPacks((ps) => ps.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {p.name}
                      <span className="pill blue" style={{ marginTop: 0, marginLeft: 8 }}>{p.jurisdiction}</span>
                      <span style={{ fontSize: 11.5, color: "#8FA3BC", marginLeft: 8, fontWeight: 600 }}>v{p.version}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#56718A", marginTop: 5, lineHeight: 1.55 }}>
                      {p.rules.length} rule{p.rules.length === 1 ? "" : "s"} — {p.rules[0].slice(0, 90)}{p.rules[0].length > 90 ? "…" : ""}
                    </div>
                  </div>
                </label>
              </div>
            ))}
            <div style={{ fontSize: 12, color: "#86868b", marginTop: 6, lineHeight: 1.5 }}>
              {policyPacks.filter((p) => p.active).length} pack(s) in force · {policyPacks.filter((p) => p.active).reduce((s, p) => s + p.rules.length, 0)} rules applied at next analysis.
            </div>

            <h2 style={{ fontSize: 18, marginTop: 20 }}>Telemetry</h2>
            <div className="mh" style={{ marginBottom: 10 }}>Per-operation latency from this session. Production telemetry (queue depth, token spend, worker saturation, error budget) is emitted server-side — see the architecture guide.</div>
            {telemetry.length === 0 ? (
              <div style={{ fontSize: 13, color: "#86868b" }}>No operations recorded yet this session.</div>
            ) : (
              <>
                <div className="grid4">
                  <div><div className="k">Operations</div><div className="x">{telemetry.length}</div></div>
                  <div><div className="k">Median latency</div><div className="x">{(() => { const s = telemetry.map((t) => t.ms).sort((a, b) => a - b); return (s[Math.floor(s.length / 2)] / 1000).toFixed(1); })()}s</div></div>
                  <div><div className="k">Slowest</div><div className="x">{(Math.max(...telemetry.map((t) => t.ms)) / 1000).toFixed(1)}s</div></div>
                  <div><div className="k">Success rate</div><div className="x">{Math.round((telemetry.filter((t) => t.ok).length / telemetry.length) * 100)}%</div></div>
                </div>
                <div style={{ marginTop: 10, maxHeight: 130, overflowY: "auto" }}>
                  {telemetry.slice().reverse().map((t, i) => (
                    <div key={i} style={{ fontSize: 12, padding: "5px 0", borderBottom: "1px solid #EEF3FA", display: "flex", gap: 10 }}>
                      <span style={{ color: "#7A8DA6", minWidth: 120 }}>{new Date(t.ts).toLocaleTimeString("en-GB")}</span>
                      <span style={{ fontWeight: 700 }}>{t.op}</span>
                      <span>{(t.ms / 1000).toFixed(1)}s</span>
                      <span style={{ color: t.ok ? "#2E9E6B" : "#E0493E", fontWeight: 700 }}>{t.ok ? "ok" : "failed"}</span>
                      {t.points != null && <span style={{ color: "#56718A" }}>{t.points} data points</span>}
                    </div>
                  ))}
                </div>
              </>
            )}

            <h2 style={{ fontSize: 18, marginTop: 20 }}>Legal</h2>
            <div className="mh" style={{ marginBottom: 10 }}>Your agreement with ContractIQ. The full canonical versions are on the website.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <button className="btn ghost sm" onClick={() => setSettingsLegal("terms")}>Terms of Use</button>
              <button className="btn ghost sm" onClick={() => setSettingsLegal("privacy")}>Privacy Policy</button>
              <button className="btn ghost sm" onClick={() => setSettingsLegal("dpa")}>DPA</button>
            </div>
            <p style={{ fontSize: 11.5, color: "#86868b", marginTop: 8, lineHeight: 1.5 }}>ContractIQ is an automated screening aid, not legal advice. Meeting transcripts may only be uploaded where you had a lawful basis and informed participants.</p>
            {settingsLegal && <LegalModal view={settingsLegal} onClose={() => setSettingsLegal(null)} />}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn" onClick={() => setShowSettings(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      <div className="footer">ContractIQ Platform &middot; {ED.name} &middot; Intelligence for every agreement &middot; <a href="../legal.html" target="_blank" rel="noopener">Legal Centre</a> &middot; <a onClick={() => { setPage("trust"); setSelectedId(null); }}>Data integrity</a>{DEMO_MODE ? " · Demo build" : ""}<br /><span style={{ opacity: 0.7 }}>A product of CodeIQ Holdings Ltd &middot; company 17454743 &middot; ICO00015500673</span></div>
    </div>
  );
}

export { matchContract, esc, hashCred, clipContext }; // TEST_EXPORTS
