/* shoot_app.mjs — capture real screenshots of the ContractIQ interface.
 *
 * The homepage showcase used to carry hand-drawn "demo screens": near
 * transparent boxes with 6px type that read as a broken page rather than a
 * product. These are the actual application instead.
 *
 * Serves the demo build the same way test_app.mjs does — React from local
 * node_modules, the heavy readers stubbed — because the sandbox blocks every
 * CDN. Run: node shoot_app.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8231;
const OUT = path.join(ROOT, "shots-raw");
fs.mkdirSync(OUT, { recursive: true });

const NM = fs.existsSync(path.join(ROOT, "node_modules/react/umd"))
  ? path.join(ROOT, "node_modules")
  : path.join(ROOT, "..", "node_modules");
const LOCAL = {
  "/vendor/react.js": path.join(NM, "react/umd/react.production.min.js"),
  "/vendor/react-dom.js": path.join(NM, "react-dom/umd/react-dom.production.min.js"),
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/demo/index.html";
  if (LOCAL[p]) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(fs.readFileSync(LOCAL[p]));
  }
  if (p.startsWith("/stub/")) {
    res.writeHead(200, { "content-type": "text/javascript" });
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
      .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/(pdf\.js|xlsx|mammoth|tesseract\.js)\/[^"]+/g, "/stub/lib.js")
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^"]+/g, "/stub/lib.js"));
  }
  res.writeHead(200, { "content-type": ct }); res.end(body);
});

await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch();
// A narrow viewport on purpose. Captured at 1600 the interface is a wide,
// sparse page, and shrunk into a half-width column on the homepage its type
// lands at about four pixels — which is exactly what was wrong with the
// placeholder screens this replaces. At 820 the app reflows into a compact
// column, so the same slot shows it at a size somebody can actually read.
const ctx = await browser.newContext({
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2,            // retina, downscaled afterwards
});
const page = await ctx.newPage();
const shot = async (name) => {
  const f = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  captured ${name}.png`);
};

await page.goto(`http://localhost:${PORT}/demo/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// ── Sign in ───────────────────────────────────────────────────────────
const demoLink = page.locator('a:has-text("Use the demo account")').first();
if (await demoLink.count()) { await demoLink.click(); await page.waitForTimeout(400); }
await page.fill('input[autocomplete="username"]', "guest");
await page.fill('input[autocomplete="current-password"]', "contractiq");
const terms = page.locator('input[type="checkbox"]').first();
if (await terms.isVisible().catch(() => false)) await terms.check();
await page.click('button:has-text("Sign in")');
await page.waitForTimeout(1200);

// ── Sample portfolio ──────────────────────────────────────────────────
await page.keyboard.press("Escape");
const gear = page.locator('[title="Settings"], button:has-text("Settings")').first();
if (await gear.count()) await gear.click().catch(() => {});
await page.waitForTimeout(400);
let loadBtn = page.locator('button:has-text("Load sample")').first();
if (!(await loadBtn.count())) loadBtn = page.locator('button:has-text("sample")').first();
if (await loadBtn.count()) { await loadBtn.click(); await page.waitForTimeout(900); }
await page.keyboard.press("Escape");
await page.waitForTimeout(700);

await shot("01-portfolio");

// ── A contract, with its analysis ─────────────────────────────────────
const firstRow = page.locator('.prow, .contract-row, tr, .card')
  .filter({ hasText: /Microsoft|CTR-/i }).first();
if (await firstRow.count()) { await firstRow.click(); await page.waitForTimeout(1000); }
await shot("02-contract");

// Walk the tabs and keep the ones that look richest.
for (const t of ["Cost", "Risk", "Verify", "Opportunities", "Insights", "Documents"]) {
  const tab = page.locator(`.tab:has-text("${t}"), button:has-text("${t}"), [role=tab]:has-text("${t}")`).first();
  if (await tab.count()) {
    await tab.click().catch(() => {});
    await page.waitForTimeout(600);
    await shot(`03-tab-${t.toLowerCase()}`);
  }
}

// ── Cedric ────────────────────────────────────────────────────────────
const fab = page.locator('.cedric-fab, button:has-text("Cedric"), [aria-label*="Cedric"]').first();
if (await fab.count()) {
  await fab.click().catch(() => {});
  await page.waitForTimeout(900);
  await shot("04-cedric");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

// ── Whatever the app calls its reporting/export surface ───────────────
for (const label of ["Reports", "Portfolio", "Dashboard", "Digest", "Export"]) {
  const nav = page.locator(`button:has-text("${label}"), a:has-text("${label}"), .nav-item:has-text("${label}")`).first();
  if (await nav.count()) {
    await nav.click().catch(() => {});
    await page.waitForTimeout(800);
    await shot(`05-${label.toLowerCase()}`);
  }
}

await browser.close();
server.close();
console.log("\nDone. Raw frames in shots-raw/");
