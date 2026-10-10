/* Text claim verification against actual code
   Checks that marketing claims match implementation
   Run: node verify_text_claims.mjs */
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync("contractiq.jsx", "utf8");
const features = fs.readFileSync("features.html", "utf8");
const pricing = fs.readFileSync("pricing.html", "utf8");

// Plan entitlement lives in the database, not compiled into the bundle —
// that is a deliberate architectural decision, not an oversight. Checks
// that looked for allowances and caps inside contractiq.jsx were therefore
// asserting the very anti-pattern the app was changed to avoid, and they
// failed for the right reason. They now read the SQL, where the answer is.
const sql = ["SETUP", "MIGRATION_003_founding", "MIGRATION_004_credits_and_billing",
             "MIGRATION_005_rollover_and_naming", "MIGRATION_006_revision_window"]
  .map((f) => {
    const p = `supabase/${f}.sql`;
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }).join("\n");
const lower = (s) => s.toLowerCase();

let pass = 0, fail = 0;
const results = [];

const check = (name, condition, detail = "") => {
  if (condition) {
    pass++;
    results.push("  ✓ " + name);
  } else {
    fail++;
    results.push("  ✗ " + name + (detail ? "\n      " + detail : ""));
  }
};

console.log("\nText Verification Against Code\n");

// === PRICING CLAIMS ===
console.log("Pricing & Plans");
check("Growth plan is £79/month", pricing.includes("£79") && src.includes("growth"));
// Was "£199" — the pre-September price, retired in the repricing. Asserting
// it meant the harness went green on a page that contradicted the database.
check("Scale plan is £270/month, and the catalogue agrees",
  pricing.includes("£270") && /'scale',[^\n]*27000/.test(sql),
  "pricing.html and plan_catalogue must both say £270 / 27000p");
check("Enterprise plan is £700/month", pricing.includes("£700") && src.includes("enterprise"));
check("Sandbox is free", /free/i.test(pricing) && /sandbox/i.test(pricing));

// === FEATURE CLAIMS ===
console.log("\nFeatures");
// Transcript ingestion was opened up to every plan; pricing.html says so.
// The old check looked for a Growth+ gate that was deliberately removed.
check("Transcript ingestion is on every plan, and the page says so",
  /transcript ingestion on every plan/i.test(pricing) && !/ED\.transcripts/.test(src),
  "pricing.html promises transcripts on every plan, so no per-plan gate should exist");
check("Cedric AI is available",
  src.includes("cedric") && src.includes("Cedric"));
check("OCR for scanned PDFs is available",
  src.includes("tesseract") || src.includes("ocr") || src.includes("OCR"));
check("Bulk analysis is queued",
  src.includes("enqueueAnalysis") || src.includes("analyseBulk"));
check("Cross-clause analysis exists",
  src.includes("crossClause") || src.includes("cross-clause"));

// === CREDIT CLAIMS ===
console.log("\nCredits & Metering");
check("Growth plan includes 500 credits/month",
  /'growth',[^\n]*?500,\s*30,\s*7900/.test(sql) && /500 credits/.test(pricing),
  "plan_catalogue and pricing.html must agree on 500 credits for Growth");
check("The app reads entitlement at runtime, not from a compiled constant",
  src.includes('rpc("my_entitlement"') && !/const EDITION = "(growth|scale|enterprise)"/.test(src),
  "a hardcoded EDITION is what gave every founding member the Enterprise feature set");
check("Credits are reserved before analysis",
  src.includes("reserve") && src.includes("credit"));
check("Credit rollover is implemented",
  fs.existsSync("supabase/MIGRATION_005_rollover_and_naming.sql"));
check("Banked credits cap per plan",
  /bank_cap = 500[^\n]*'growth'/.test(sql) && /bank_cap = 1800[^\n]*'scale'/.test(sql),
  "the roll-over cap is enforced in MIGRATION_005, not in the bundle");
check("Re-runs inside the revision window are free, as pricing.html promises",
  /reanalysis_is_free/.test(sql) && /0 credits/.test(pricing),
  "the page advertises free re-runs; the database must not charge for them");

// === SECURITY & PRIVACY CLAIMS ===
console.log("\nSecurity & Privacy");
check("Transcript names are pseudonymised",
  src.includes("pseudonymiseTranscript") && src.includes("Participant"));
check("Real names restored only on display",
  src.includes("rehydrate") && src.includes("deAnon"));
check("Pseudonymisation map never persisted",
  features.includes("volatile") || features.includes("session memory") ||
  src.includes("toReal") && src.includes("toPseudo"));
check("Supabase Row Level Security enforced",
  src.includes("RLS") || features.includes("RLS"));

// === ANALYSIS FEATURES ===
console.log("\nAnalysis");
// Was looking for the literal word "amount", which is not what the fields
// are called. The extraction is real; the check was reading for the wrong
// vocabulary and failing a feature that ships.
check("Analysis includes value extraction",
  src.includes("annualValue") && src.includes("uplift") && src.includes("estimatedAnnualSaving"),
  "annual value, uplift schedule and saving estimate must all be extracted");
check("Analysis includes term dates",
  src.includes("startDate") || src.includes("endDate"));
check("Analysis includes risk scoring",
  src.includes("risk") || src.includes("riskScore"));
check("Confidence scores provided",
  src.includes("confidence") || src.includes("Confidence"));

// === RATE LIMITS ===
console.log("\nRate Limits");
check("20 analyses per hour documented",
  features.includes("20 analyses") || features.includes("20 per hour"));
check("120 Cedric questions per hour documented",
  features.includes("120") || features.includes("Cedric") && features.includes("questions"));

// === AUTHENTICATION ===
console.log("\nAuthentication");
check("Supabase auth is used",
  src.includes("createClient") && src.includes("auth"));
check("Demo account works with credentials",
  src.includes("guest") && src.includes("DEMO"));
check("OAuth is not required for guest access",
  src.includes("DEMO_MODE"));

// === DATABASE ===
console.log("\nDatabase");
// Was case-sensitive, so "Postgres" and "SQL" in the source never matched.
check("Supabase PostgreSQL backend",
  lower(src).includes("supabase") && /create table if not exists contracts/i.test(sql),
  "the backend is Supabase, and the schema is in supabase/*.sql");
check("No custom database needed",
  !features.includes("custom database") || features.includes("Supabase"));
check("RLS provides multi-tenant isolation",
  features.includes("Row Level Security") || features.includes("RLS"));

// === EXPORTS ===
console.log("\nExports");
check("Reports can be exported",
  src.includes("export") || src.includes("buildReport"));
check("Audit trail is exported with reports",
  src.includes("auditTrail") || src.includes("audit") && src.includes("export"));

// === UI CLAIMS ===
console.log("\nUI/UX");
check("App runs in any browser",
  !features.includes("desktop app required") && features.includes("browser"));
check("No installation required",
  !features.includes("download") && !features.includes("install") || features.includes("browser"));
check("Dark theme matches branding",
  features.includes("dark") && features.includes("navy") || features.includes("teal"));

// === LIMITATIONS (what's NOT there) ===
console.log("\nAbsent Features (correctly not claimed)");
check("No API is documented",
  !pricing.includes(" API") && !features.includes(" API") || features.includes("coming"));
check("No desktop app is built",
  !features.includes("desktop app") || features.includes("web-only"));
check("No SSO/SAML (doesn't claim it)",
  !features.includes("SSO") && !features.includes("SAML"));

results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
