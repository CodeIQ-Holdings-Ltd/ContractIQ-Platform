/* Four screenshots for the gallery on codeiqholdings.co.uk.
 *
 *   node tools/shoot_codeiq_gallery.mjs      → writes /tmp/shots/ciq-*.png
 *
 * Signs into the DEMO build with its sample portfolio, so every figure,
 * supplier and name in the images is invented. Never point this at a real
 * workspace: a screenshot of customer data on a public site is a personal
 * data breach.
 *
 * Writes, at 1600x1000 (the size the CodeIQ gallery expects):
 *   ciq-portfolio.png  ciq-renewals.png  ciq-analysis.png  ciq-risk.png
 *
 * Copy them into codeiqholdings-website/assets/screenshots/ and, if the
 * view has changed, rewrite the alt text in that site's index.html.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8357;

// The sandbox blocks cdnjs, so the demo would hang at boot waiting for
// React. Serve React from local node_modules and rewrite the page's CDN
// tags to point at them; the lazily-loaded readers (pdf.js, xlsx, mammoth,
// tesseract) are not needed to boot, so stub them to an empty 200 rather
// than let them hang the load event.
const NM = fs.existsSync(path.join(ROOT, "node_modules/react/umd"))
  ? path.join(ROOT, "node_modules") : path.join(ROOT, "..", "node_modules");
const LOCAL = {
  "/vendor/react.js": path.join(NM, "react/umd/react.production.min.js"),
  "/vendor/react-dom.js": path.join(NM, "react-dom/umd/react-dom.production.min.js"),
};
const supabaseStub = `
window.supabase = {
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => () => {},
      signOut: async () => ({ error: null }),
    },
    from: (table) => ({
      select: (...args) => ({
        eq: () => ({ data: [], error: null }),
        then: (cb) => cb({ data: [], error: null }),
      }),
      insert: async (data) => ({ data, error: null }),
      update: async (data) => ({ data, error: null }),
    }),
  }),
};
`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/demo/index.html";
  if (LOCAL[p]) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(fs.readFileSync(LOCAL[p]));
  }
  if (p.startsWith("/stub/")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    if (p === "/stub/supabase.js") return res.end(supabaseStub);
    return res.end("/* stubbed */");
  }
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); return res.end("nf");
  }
  const ext = path.extname(fp);
  const ct = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" }[ext] || "text/plain";
  let body = fs.readFileSync(fp);
  if (ext === ".html") {
    body = Buffer.from(body.toString()
      .replace(/<link[^>]+fonts\.googleapis[^>]+>/g, "")
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/[^"]+react\.production\.min\.js/g, "/vendor/react.js")
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/[^"]+react-dom\.production\.min\.js/g, "/vendor/react-dom.js")
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/(pdf\.js|xlsx|mammoth|tesseract\.js)\/[^"']+/g, "/stub/lib.js")
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^"]+/g, "/stub/supabase.js")
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^"]+/g, "/stub/lib.js"));
  }
  res.writeHead(200, { "content-type": ct }); res.end(body);
});


const OUT = process.env.OUT || path.join(ROOT, "shots-codeiq");
fs.mkdirSync(OUT, { recursive: true });
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage();
const errs = []; page.on("pageerror", e => errs.push(e.message));
const settle = (ms = 900) => page.waitForTimeout(ms);
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log("shot", n); };

await page.goto(`http://localhost:${PORT}/demo/index.html`, { waitUntil: "networkidle" });
await settle();
const demoLink = page.locator('text=Use the demo account').first();
if (await demoLink.count()) { await demoLink.click(); await settle(1200); }
await page.fill('input[autocomplete="username"]', "guest");
await page.fill('input[autocomplete="current-password"]', "contractiq");
const terms = page.locator('input[type="checkbox"]').first();
if (await terms.isVisible()) await terms.check();
await page.click('button:has-text("Sign in")');
await settle(2000);
const load = page.locator('button:has-text("Load a sample portfolio")').first();
if (await load.count()) { await load.click(); await settle(2500); }

// #mode-banner is the demo build's own label, not product UI, and it sits
// over the credit line. Everything else on screen is the real application.
await page.addStyleTag({ content: '#mode-banner{display:none!important}' });

// 1 · The renewal runway, ordered by notice deadline
await page.evaluate(() => window.scrollTo(0, 330)); await settle();
await shot("ciq-renewals");

// 2 · The portfolio: alert centre and the record cards
await page.evaluate(() => window.scrollTo(0, 790)); await settle();
await shot("ciq-portfolio");

// 3 · An analysed record: confidence scores and the quoted source
await page.locator(':text("Enterprise Agreement")').first().click();
await settle(1800);
const verify = page.locator('.tab:has-text("Verify"), button:has-text("Verify")').first();
if (await verify.count()) { await verify.click(); await settle(1100); }
await page.evaluate(() => window.scrollTo(0, 165)); await settle();
await shot("ciq-analysis");
await page.evaluate(() => window.scrollTo(0, 210));
for (const t of []) {
  const tab = page.locator(`.tab:has-text("${t}"), button:has-text("${t}")`).first();
  if (await tab.count()) { await tab.click(); await settle(900); await shot("alt-" + t.toLowerCase()); }
}

// 4 · Supplier risk
await page.evaluate(() => window.scrollTo(0, 0)); await settle(400);
await page.locator('.nav-item:has-text("Intelligence")').first().click(); await settle(600);
await page.locator('.nav-menu-i:has-text("Vendor risk")').first().click(); await settle(1800);
await page.evaluate(() => window.scrollTo(0, 150)); await settle();
await shot("ciq-risk");

console.log("page errors:", errs.length, errs.slice(0,2).join(" | "));
await browser.close(); server.close();
