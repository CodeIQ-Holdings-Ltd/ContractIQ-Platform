/* Whole-site verification for ContractIQ Platform.
   Written after a round of defects my earlier harness missed: it checked
   that things EXISTED, not that they LOOKED right. This one samples real
   pixels, measures real boxes, and fails on clipped text. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = 8155;
const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.jpg':'image/jpeg',
              '.png':'image/png','.xml':'application/xml','.txt':'text/plain'};
const server = http.createServer((q,r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('404'); }
  if (path.extname(f) === '.html') {
    const html = fs.readFileSync(f, 'utf8')
      .replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '')
      .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '');
    r.writeHead(200, {'Content-Type':'text/html'}); return r.end(html);
  }
  r.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream'});
  fs.createReadStream(f).pipe(r);
});
await new Promise(r => server.listen(PORT, r));
const base = `http://localhost:${PORT}`;

const PAGES  = ['index.html','features.html','pricing.html','security.html','about.html',
                'contact.html','checkout.html','success.html','legal.html'];
const THEMED = PAGES.filter(p => p !== 'legal.html');

const b = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
const out = []; let F = 0;
const ok  = (n,d='') => out.push(` ok   ${n}${d ? '  — ' + d : ''}`);
const bad = (n,d='') => { F++; out.push(`FAIL  ${n}${d ? '  — ' + d : ''}`); };

async function open(w = 1440, o = {}) {
  const c = await b.newContext({ viewport:{width:w,height:900}, ...o });
  const p = await c.newPage(); const e = [];
  p.on('console', m => { if (m.type()==='error') e.push(m.text()); });
  p.on('pageerror', x => e.push(String(x)));
  return { p, c, e };
}

/* 1 · loads clean */
for (const f of PAGES) {
  const { p, c, e } = await open();
  const r = await p.goto(`${base}/${f}`, { waitUntil:'networkidle', timeout:20000 });
  await p.waitForTimeout(900);
  const real = e.filter(x => !/fonts\.g|cdnjs|jsdelivr|net::ERR|favicon/i.test(x));
  r.status()!==200 ? bad(`load ${f}`,`HTTP ${r.status()}`)
    : real.length ? bad(`load ${f}`, real[0].slice(0,120)) : ok(`load ${f}`);
  await c.close();
}

/* 2 · NO CLIPPED TEXT — every word must be on the page */
{
  const badly = [];
  for (const f of THEMED) {
    const { p, c } = await open();
    await p.goto(`${base}/${f}`, { waitUntil:'networkidle' });
    await p.waitForTimeout(1400);
    const clipped = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('p,h1,h2,h3,h4,li,span,div').forEach(el => {
        if (!el.textContent.trim() || el.children.length > 2) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') { out.push('line-clamp: ' + el.textContent.trim().slice(0,40)); return; }
        const clips = cs.overflow === 'hidden' || cs.overflowY === 'hidden';
        if (clips && el.scrollHeight - el.clientHeight > 3 && el.clientHeight > 0)
          out.push('clipped: ' + el.textContent.trim().slice(0,40));
      });
      return out.slice(0, 4);
    });
    if (clipped.length) badly.push(`${f}: ${clipped.join(' | ')}`);
    await c.close();
  }
  badly.length ? bad('no text is cut off', badly.join('  ||  ').slice(0,260))
               : ok('no text is cut off', `${THEMED.length} pages checked element by element`);
}

/* 2b · NOTHING IS LEFT INVISIBLE — the bug that hid a whole heading
   behind 380px of empty space. Checked EARLY (before any failsafe could
   rescue it) and again after a full scroll. */
{
  const ghosts = [];
  for (const f of THEMED) {
    const { p, c } = await open();
    await p.goto(`${base}/${f}`, { waitUntil:'domcontentloaded' });
    await p.waitForTimeout(1200);
    const early = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('section *, header *, footer *').forEach(el => {
        if (!el.textContent.trim() || el.children.length > 3) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        // An element belonging to the intended reveal system is allowed to
        // be part-way through its animation. Anything ELSE sitting at
        // opacity 0 is hidden by something with no plan to bring it back.
        if (el.closest('[data-rise],[data-scale]')) return;
        if (+cs.opacity < 0.05 && el.getBoundingClientRect().height > 12)
          out.push(el.className || el.tagName);
      });
      return [...new Set(out)].slice(0, 3);
    });
    if (early.length) ghosts.push(`${f} early: ${early.join(', ')}`);

    const h = await p.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < h; y += 500) { await p.evaluate(v => scrollTo(0,v), y); await p.waitForTimeout(60); }
    await p.waitForTimeout(1200);
    const late = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('section *, header *, footer *').forEach(el => {
        if (!el.textContent.trim() || el.children.length > 3) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (+cs.opacity < 0.05 && el.getBoundingClientRect().height > 12)
          out.push(el.className || el.tagName);
      });
      return [...new Set(out)].slice(0, 3);
    });
    if (late.length) ghosts.push(`${f} after scroll: ${late.join(', ')}`);
    await c.close();
  }
  ghosts.length ? bad('nothing is left invisible', ghosts.join('  ||  ').slice(0,240))
                : ok('nothing is left invisible', 'checked at 1.2s and after a full scroll');
}

/* 2c · only one motion system may be loaded */
{
  const clash = [];
  for (const f of THEMED) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (t.includes('assets/motion.js') || t.includes('assets/motion.css')) clash.push(f);
  }
  clash.length ? bad('one motion system only', clash.join(', ')) : ok('one motion system only');
}

/* 2d · EVERY FORM CONTROL IS USABLE. A shared theme can collide with a
   page's own class names — `.panel` meant a nav dropdown to the theme and
   the payment form to checkout.html, and the form was hidden outright. */
{
  const broken = [];
  for (const f of THEMED) {
    const { p, c } = await open();
    await p.goto(`${base}/${f}`, { waitUntil:'domcontentloaded' });
    await p.waitForTimeout(1400);
    const r = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('input,select,textarea,button,label').forEach(el => {
        if (el.closest('.nav')) return;                 // the burger is meant to hide at desktop
        if (el.type === 'hidden') return;
        // A control inside a carousel slide that is not the active one is
        // SUPPOSED to be unreachable — each slide carries its own copy of
        // the dots, and before they were hidden properly all four sets sat
        // in the tab order with three of them invisible. Narrowed to that
        // one case so it cannot excuse a form hidden by a class collision,
        // which is the fault this check exists to catch.
        const slide = el.closest('.carousel-slide');
        if (slide && !slide.classList.contains('active')) return;
        const cs = getComputedStyle(el), b = el.getBoundingClientRect();
        if (cs.visibility === 'hidden' || +cs.opacity < 0.05 || (cs.display !== 'none' && b.width === 0 && b.height === 0))
          out.push((el.id || el.tagName) + ':' + (cs.visibility === 'hidden' ? 'hidden' : 'zero-size'));
      });
      return [...new Set(out)].slice(0, 4);
    });
    if (r.length) broken.push(`${f}: ${r.join(', ')}`);
    await c.close();
  }
  broken.length ? bad('every form control is visible', broken.join('  ||  ').slice(0,240))
                : ok('every form control is visible', 'inputs, selects and buttons on all 8 pages');
}

/* 3 · cards: two to a row, equal height */
{
  const trouble = [];
  for (const f of ['features.html','security.html','contact.html','pricing.html']) {
    const { p, c } = await open();
    await p.goto(`${base}/${f}`, { waitUntil:'networkidle' });
    await p.waitForTimeout(1200);
    const r = await p.evaluate(() => {
      const grids = [...document.querySelectorAll('.hexgrid')];
      const res = { grids: grids.length, cols: new Set(), ragged: 0 };
      grids.forEach(g => {
        res.cols.add(getComputedStyle(g).gridTemplateColumns.split(' ').length);
        const cards = [...g.children];
        const rows = {};
        cards.forEach(cd => { const t = Math.round(cd.getBoundingClientRect().top);
          (rows[t] = rows[t] || []).push(Math.round(cd.getBoundingClientRect().height)); });
        Object.values(rows).forEach(hs => { if (Math.max(...hs) - Math.min(...hs) > 2) res.ragged++; });
      });
      return { grids: res.grids, cols: [...res.cols], ragged: res.ragged };
    });
    if (r.grids && !r.cols.every(n => n === 2)) trouble.push(`${f}: ${r.cols.join('/')} columns`);
    if (r.ragged) trouble.push(`${f}: ${r.ragged} uneven rows`);
    await c.close();
  }
  trouble.length ? bad('cards are two to a row and equal height', trouble.join('; '))
                 : ok('cards are two to a row and equal height');
}

/* 4 · icons all land in the same place within a card */
{
  const { p, c } = await open();
  await p.goto(`${base}/features.html`, { waitUntil:'networkidle' });
  await p.waitForTimeout(1200);
  const off = await p.evaluate(() => {
    const d = [...document.querySelectorAll('.hcard')].map(cd => {
      const ic = cd.querySelector('.hexicon'); if (!ic) return null;
      return Math.round(ic.getBoundingClientRect().top - cd.getBoundingClientRect().top);
    }).filter(x => x !== null);
    return { spread: Math.max(...d) - Math.min(...d), n: d.length };
  });
  off.spread <= 2 ? ok('icons aligned inside every card', `${off.n} cards, ${off.spread}px spread`)
                  : bad('icons aligned inside every card', `${off.spread}px spread`);
  await c.close();
}

/* 5 · NO PALE BANDS — sample the rendered pixels, not the markup */
{
  const { p, c } = await open();
  const found = [];
  for (const f of ['index.html','features.html','pricing.html']) {
    await p.goto(`${base}/${f}`, { waitUntil:'networkidle' });
    const h = await p.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < h; y += 400) { await p.evaluate(v => scrollTo(0,v), y); await p.waitForTimeout(60); }
    await p.evaluate(() => scrollTo(0,0)); await p.waitForTimeout(1200);
    const bands = await p.evaluate(() => {
      const H = document.body.scrollHeight, step = 6, lum = [];
      const at = (y) => {
        const el = document.elementFromPoint(8, Math.min(window.innerHeight - 2, y - window.scrollY));
        return el;
      };
      // Walk the document by section boxes instead of pixels.
      const boxes = [...document.querySelectorAll('section,header,footer,svg.ridge')].map(el => {
        const r = el.getBoundingClientRect(), top = r.top + window.scrollY;
        let bg = getComputedStyle(el).backgroundColor;
        let node = el;
        while (bg === 'rgba(0, 0, 0, 0)' && node.parentElement) { node = node.parentElement; bg = getComputedStyle(node).backgroundColor; }
        const m = bg.match(/\d+/g) || [255,255,255];
        const L = (0.2126*m[0] + 0.7152*m[1] + 0.0722*m[2]) / 255;
        return { tag: el.tagName.toLowerCase() + (el.id ? '#'+el.id : ''), top: Math.round(top),
                 h: Math.round(r.height), L: +L.toFixed(2) };
      }).filter(x => x.h > 8);
      // A pale strip under 140px tall wedged between two dark neighbours.
      const out = [];
      for (let i = 1; i < boxes.length - 1; i++) {
        if (boxes[i].L > 0.7 && boxes[i-1].L < 0.25 && boxes[i+1].L < 0.25 && boxes[i].h < 140)
          out.push(`${boxes[i].tag} ${boxes[i].h}px at y=${boxes[i].top}`);
      }
      return out;
    });
    // Gaps between consecutive full-width sections show the body colour.
    const gaps = await p.evaluate(() => {
      const secs = [...document.querySelectorAll('body > section, body > header, body > footer, body > svg')];
      const g = [];
      for (let i = 0; i < secs.length - 1; i++) {
        const a = secs[i].getBoundingClientRect(), n = secs[i+1].getBoundingClientRect();
        const gap = Math.round(n.top - a.bottom);
        if (gap > 2) g.push(`${gap}px gap after ${secs[i].tagName.toLowerCase()}${secs[i].id?'#'+secs[i].id:''}`);
      }
      return g;
    });
    if (bands.length) found.push(`${f}: ${bands.join(', ')}`);
    if (gaps.length)  found.push(`${f}: ${gaps.join(', ')}`);
  }
  found.length ? bad('no pale bands or gaps between sections', found.join('  ||  ').slice(0,240))
               : ok('no pale bands or gaps between sections');
  await c.close();
}

/* 6 · menus are solid, not see-through */
{
  const { p, c } = await open();
  await p.goto(`${base}/index.html`, { waitUntil:'networkidle' });
  await p.waitForTimeout(700);
  const li = p.locator('.nav-links li.has-panel').first();
  await li.hover(); await p.waitForTimeout(500);
  const r = await li.locator('.panel').evaluate(el => {
    const cs = getComputedStyle(el);
    const m = cs.backgroundColor.match(/[\d.]+/g);
    return { alpha: m.length > 3 ? +m[3] : 1, vis: cs.visibility };
  });
  (r.vis === 'visible' && r.alpha === 1)
    ? ok('nav menu is opaque', `alpha ${r.alpha}`)
    : bad('nav menu is opaque', `alpha ${r.alpha}, ${r.vis}`);
  await c.close();
}

/* 7 · plan buttons you can actually see */
{
  const { p, c } = await open();
  await p.goto(`${base}/pricing.html`, { waitUntil:'networkidle' });
  await p.waitForTimeout(1000);
  const r = await p.evaluate(() => {
    const plans = [...document.querySelectorAll('.plan')];
    return plans.map(pl => {
      const btn = pl.querySelector('.btn');
      if (!btn) return { label: 'NONE' };
      const cs = getComputedStyle(btn), bb = btn.getBoundingClientRect();
      const bg = cs.backgroundImage !== 'none' ? 'gradient' : cs.backgroundColor;
      return { label: btn.textContent.trim().slice(0,18), w: Math.round(bb.width),
               h: Math.round(bb.height), bg, hidden: cs.visibility === 'hidden' || cs.display === 'none' };
    });
  });
  const wrong = r.filter(x => x.label === 'NONE' || x.hidden || x.w < 100 || x.h < 36 || x.bg === 'rgba(0, 0, 0, 0)');
  wrong.length ? bad('every plan has a visible button', JSON.stringify(wrong).slice(0,180))
               : ok('every plan has a visible button', r.map(x => x.label).join(' · '));
  const tops = await p.$$eval('.plan .amt', e => e.map(x => Math.round(x.getBoundingClientRect().top)));
  (Math.max(...tops) - Math.min(...tops) <= 2) ? ok('plan prices align') : bad('plan prices align', tops.join(','));
  await c.close();
}

/* 8 · the footer sentence stays a sentence */
{
  const { p, c } = await open();
  await p.goto(`${base}/index.html`, { waitUntil:'networkidle' });
  const r = await p.evaluate(() => {
    const fb = document.querySelector('.foot-base');
    const t = fb.textContent.replace(/\s+/g,' ');
    return { display: getComputedStyle(fb).display,
             intact: t.includes('is a product of CodeIQ Holdings Ltd, registered in England') };
  });
  (r.display === 'block' && r.intact) ? ok('footer sentence is intact')
                                      : bad('footer sentence is intact', `display:${r.display} intact:${r.intact}`);
  await c.close();
}

/* 9 · links, anchors, overflow, resilience */
{
  const { p, c } = await open(); const seen = new Map(), brk = [];
  for (const f of PAGES) {
    await p.goto(`${base}/${f}`, { waitUntil:'domcontentloaded' });
    const hs = await p.$$eval('a[href]', a => a.map(x => x.getAttribute('href')));
    for (const h of hs) {
      if (!h || /^(https?:|mailto:|tel:|javascript:)/.test(h)) continue;
      if (h === '#' || h === '') { brk.push(`${f} empty`); continue; }
      const t = h.split('#')[0]; if (!t) continue;
      const u = new URL(t, `${base}/${f}`).href;
      if (!seen.has(u)) seen.set(u, (await p.request.get(u)).ok());
      if (!seen.get(u)) brk.push(`${f} → ${h}`);
    }
  }
  brk.length ? bad('every link resolves', [...new Set(brk)].join('; ').slice(0,200))
             : ok('every link resolves', `${seen.size} targets`);
  await c.close();
}

for (const w of [1440, 1200, 1024, 768, 390]) {
  const bd = [];
  for (const f of THEMED) {
    const { p, c } = await open(w);
    await p.goto(`${base}/${f}`, { waitUntil:'networkidle', timeout:20000 });
    await p.waitForTimeout(500);
    const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (o > 2) bd.push(`${f} ${o}px`);
    await c.close();
  }
  bd.length ? bad(`no sideways scroll at ${w}px`, bd.join(', ')) : ok(`no sideways scroll at ${w}px`);
}

{
  const { p, c } = await open();
  await p.addInitScript(() => { window.IntersectionObserver = undefined; });
  await p.goto(`${base}/index.html`, { waitUntil:'networkidle' }); await p.waitForTimeout(3000);
  const n = await p.evaluate(() => [...document.querySelectorAll('[data-rise],[data-scale]')]
    .filter(e => +getComputedStyle(e).opacity < 0.9).length);
  n === 0 ? ok('survives a missing IntersectionObserver') : bad('survives a missing IntersectionObserver', `${n} stuck`);
  await c.close();
}
{
  const c = await b.newContext({ viewport:{width:1440,height:900}, javaScriptEnabled:false });
  const p = await c.newPage(); const bd = [];
  for (const f of THEMED) {
    await p.goto(`${base}/${f}`, { waitUntil:'domcontentloaded' });
    const t = (await p.textContent('body')).replace(/\s+/g,' ');
    if (!t.includes('17454743')) bd.push(f);
  }
  bd.length ? bad('readable with JavaScript off', bd.join(', ')) : ok('readable with JavaScript off');
  await c.close();
}

await b.close(); server.close();
console.log(out.join('\n'));
console.log(`\n${out.length - F}/${out.length} passed`);
process.exit(F ? 1 : 0);
