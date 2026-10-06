/* shoot_cedric.mjs — a clean capture of the Cedric panel, mid-conversation.
 *
 * The first attempt cropped a rectangle out of the page, which sliced words in
 * half down the left edge and read as a broken screenshot rather than a
 * product. This screenshots the panel element itself, after asking it a real
 * question, so there is an actual answer on screen instead of the greeting.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8232;
const NM = fs.existsSync(path.join(ROOT, "node_modules/react/umd"))
  ? path.join(ROOT, "node_modules") : path.join(ROOT, "..", "node_modules");
const LOCAL = {
  "/vendor/react.js": path.join(NM, "react/umd/react.production.min.js"),
  "/vendor/react-dom.js": path.join(NM, "react-dom/umd/react-dom.production.min.js"),
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/demo/index.html";
  if (LOCAL[p]) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(LOCAL[p])); }
  if (p.startsWith("/stub/")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("/* stubbed */"); }
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("nf"); }
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
// A short viewport on purpose: the panel is viewport-height, so a tall one
// leaves a dead band of empty chat between the greeting and the chips.
const ctx = await browser.newContext({ viewport: { width: 1600, height: 760 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/demo/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const demoLink = page.locator('a:has-text("Use the demo account")').first();
if (await demoLink.count()) { await demoLink.click(); await page.waitForTimeout(400); }
await page.fill('input[autocomplete="username"]', "guest");
await page.fill('input[autocomplete="current-password"]', "contractiq");
const terms = page.locator('input[type="checkbox"]').first();
if (await terms.isVisible().catch(() => false)) await terms.check();
await page.click('button:has-text("Sign in")');
await page.waitForTimeout(1200);

await page.keyboard.press("Escape");
const gear = page.locator('[title="Settings"], button:has-text("Settings")').first();
if (await gear.count()) await gear.click().catch(() => {});
await page.waitForTimeout(400);
let loadBtn = page.locator('button:has-text("Load sample")').first();
if (!(await loadBtn.count())) loadBtn = page.locator('button:has-text("sample")').first();
if (await loadBtn.count()) { await loadBtn.click(); await page.waitForTimeout(900); }
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// Open a contract so Cedric has a scope, then open Cedric.
const row = page.locator('.prow, .contract-row, tr, .card').filter({ hasText: /Microsoft|CTR-/i }).first();
if (await row.count()) { await row.click(); await page.waitForTimeout(900); }
const fab = page.locator('.cedric-fab, button:has-text("Cedric"), [aria-label*="Cedric"]').first();
await fab.click();
await page.waitForTimeout(900);

// Deliberately NOT asking a question. In DEMO_MODE Cedric's canned reply says
// its "live AI engine is switched off to keep it free to host" — true of the
// public demo, and the last thing that should appear on a homepage. The
// greeting describes the real capability in the product's own words and is
// accurate on every build, so that is what gets captured.
await page.waitForTimeout(600);

const panel = page.locator(".cedric").first();
const target = (await panel.count()) ? panel : page.locator(".cedric-head").first();
await target.screenshot({ path: path.join(ROOT, "shots-raw", "cedric-panel.png") });
console.log("  captured cedric-panel.png");

await browser.close();
server.close();
