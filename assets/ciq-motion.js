/* ═══════════════════════════════════════════════════════════════
   ContractIQ Platform — shared motion and interaction
   CodeIQ Holdings Ltd · September 2026

   ONE RULE ABOVE ALL OTHERS, and everything here is arranged around it:
   the page must read even if this file never runs. Content is visible
   by default in CSS and only hides once `.js` is set, the safety net is
   armed before anything that could throw, and every feature sits in its
   own try/catch so one broken widget cannot take the page down with it.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var fine = true;
  try { fine = window.matchMedia('(hover:hover) and (pointer:fine)').matches; } catch (e) {}

  /* ── Reveal ──────────────────────────────────────────────── */
  function reveal(el) {
    if (!el || el.classList.contains('in')) return;
    el.classList.add('in');
    countUp(el);
  }
  function revealAll() {
    var all = document.querySelectorAll('[data-rise],[data-scale],#rail');
    for (var i = 0; i < all.length; i++) reveal(all[i]);
  }
  function revealInView() {
    var t = document.querySelectorAll('[data-rise],[data-scale],#rail'),
        h = window.innerHeight || 800;
    for (var i = 0; i < t.length; i++) {
      var r = t[i].getBoundingClientRect();
      if (r.top < h * 0.92 && r.bottom > 0) reveal(t[i]);
    }
  }

  /* Armed FIRST. Whatever happens below, the content arrives. */
  setTimeout(revealAll, 2200);
  window.addEventListener('load', function () { revealInView(); setTimeout(revealAll, 900); });
  window.addEventListener('scroll', revealInView, { passive: true });

  /* ── Numbers ─────────────────────────────────────────────── */
  function countUp(scope) {
    try {
      var nums = scope.querySelectorAll ? scope.querySelectorAll('[data-count]') : [];
      if (scope.hasAttribute && scope.hasAttribute('data-count')) nums = [scope];
      for (var i = 0; i < nums.length; i++) (function (el) {
        if (el.getAttribute('data-done')) return;
        el.setAttribute('data-done', '1');
        var target = parseFloat(el.getAttribute('data-count')),
            dp = parseInt(el.getAttribute('data-dp') || '0', 10),
            pre = el.getAttribute('data-prefix') || '',
            suf = el.getAttribute('data-suffix') || '';
        if (isNaN(target)) return;
        if (reduce) { el.textContent = pre + target.toFixed(dp) + suf; return; }
        var t0 = performance.now();
        (function tick(now) {
          var p = Math.min(1, (now - t0) / 1500), e = 1 - Math.pow(1 - p, 3);
          el.textContent = pre + (target * e).toFixed(dp) + suf;
          if (p < 1) requestAnimationFrame(tick);
        })(t0);
      })(nums[i]);
    } catch (e) {}
  }

  /* Feature-detect by TYPE. `'IntersectionObserver' in window` is true
     even when the value is undefined, which sends you into a constructor
     that throws — and that is how a whole page ends up invisible. */
  try {
    if (!reduce && typeof window.IntersectionObserver === 'function') {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); } });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
      var t = document.querySelectorAll('[data-rise],[data-scale],#rail');
      for (var i = 0; i < t.length; i++) io.observe(t[i]);
    } else { revealAll(); }
  } catch (e) { revealAll(); }
  revealInView();
  setTimeout(revealInView, 300);

  /* ── The mountains ───────────────────────────────────────────
     Three movements, layered, all small: a slow continuous drift so the
     scene is never quite still, a lean of a few pixels toward the
     cursor, and parallax as you scroll. Each is capped deliberately —
     the picture should breathe behind the words, not perform. */
  try {
    var bgImgs = document.querySelectorAll('.ciq-bg img');
    if (bgImgs.length && !reduce) {
      var mx = 0, my = 0, tx = 0, ty = 0, scrollY = 0, t0 = performance.now();

      if (fine) {
        window.addEventListener('pointermove', function (e) {
          var w = window.innerWidth || 1, h = window.innerHeight || 1;
          tx = ((e.clientX / w) - 0.5) * 2;   /* -1 … 1 */
          ty = ((e.clientY / h) - 0.5) * 2;
        }, { passive: true });
      }
      window.addEventListener('scroll', function () { scrollY = window.scrollY || 0; }, { passive: true });

      (function frame(now) {
        /* Ease toward the pointer rather than snapping to it, so the
           movement always feels like weight and never like a twitch. */
        mx += (tx - mx) * 0.045;
        my += (ty - my) * 0.045;
        var t = (now - t0) / 1000;
        var driftX = Math.sin(t * 0.055) * 10 + Math.sin(t * 0.021) * 5;
        var driftY = Math.cos(t * 0.041) * 7;
        var leanX = mx * -16, leanY = my * -9;
        var par = Math.min(scrollY, 1400) * 0.13;

        for (var i = 0; i < bgImgs.length; i++) {
          bgImgs[i].style.transform =
            'translate3d(' + (driftX + leanX).toFixed(2) + 'px,' +
            (driftY + leanY + par).toFixed(2) + 'px,0) scale(1.04)';
        }
        requestAnimationFrame(frame);
      })(t0);
    }
  } catch (e) { /* a still photograph is a perfectly good photograph */ }

  /* ── Nav ─────────────────────────────────────────────────── */
  try {
    var nav = document.querySelector('.nav');
    if (nav) {
      var onScroll = function () {
        if (window.scrollY > 24) nav.classList.add('stuck'); else nav.classList.remove('stuck');
      };
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return; ticking = true;
        requestAnimationFrame(function () { onScroll(); ticking = false; });
      }, { passive: true });
      onScroll();

      var burger = nav.querySelector('.burger');
      if (burger) burger.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });

      /* Hover panels. On a pointer device they open on hover with a
         short close delay, so crossing the gap between the label and
         the panel does not snatch it away. On touch, a tap toggles. */
      var items = nav.querySelectorAll('.nav-links li.has-panel');
      for (var n = 0; n < items.length; n++) (function (li) {
        var trigger = li.querySelector('.trigger'), timer = null;
        var open = function () {
          clearTimeout(timer);
          for (var k = 0; k < items.length; k++) if (items[k] !== li) items[k].classList.remove('open');
          li.classList.add('open');
          if (trigger) trigger.setAttribute('aria-expanded', 'true');
        };
        var close = function (delay) {
          clearTimeout(timer);
          timer = setTimeout(function () {
            li.classList.remove('open');
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
          }, delay || 0);
        };
        if (fine) {
          li.addEventListener('mouseenter', open);
          li.addEventListener('mouseleave', function () { close(180); });
        }
        if (trigger) {
          trigger.addEventListener('click', function (e) {
            e.preventDefault();
            li.classList.contains('open') ? close(0) : open();
          });
          trigger.addEventListener('focus', open);
        }
        li.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(0); });
        li.addEventListener('focusout', function (e) {
          if (!li.contains(e.relatedTarget)) close(120);
        });
      })(items[n]);

      document.addEventListener('click', function (e) {
        if (!nav.contains(e.target)) {
          nav.classList.remove('open');
          for (var k = 0; k < items.length; k++) items[k].classList.remove('open');
        }
      });
      var links = nav.querySelector('.nav-links');
      if (links) links.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') nav.classList.remove('open');
      });
    }
  } catch (e) {}

  /* ── The card rollover ───────────────────────────────────────
     The light follows the cursor, and the body text opens out. The
     clamp lives in CSS behind a `hover:hover` query, so a phone never
     hides anything in the first place. */
  try {
    var cards = document.querySelectorAll('.hcard,.cell');
    for (var c = 0; c < cards.length; c++) (function (card) {
      if (fine && !reduce) {
        card.addEventListener('pointermove', function (e) {
          var r = card.getBoundingClientRect();
          card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
          card.style.setProperty('--my', (e.clientY - r.top) + 'px');
        });
      }
      /* Only clamp text that is ACTUALLY too long. A card whose copy
         already fits should not be trimmed, and must not advertise a
         hover that reveals nothing — which is worse than no cue at all.
         Measured after layout, per card, at the current width. */
      var para = card.querySelector('p.clamp');
      var cue = card.querySelector('.more');
      if (para) {
        var overflowing = para.scrollHeight - para.clientHeight > 4;
        if (!overflowing) {
          para.classList.remove('clamp');
          if (cue) cue.parentNode.removeChild(cue);
        } else if (!card.hasAttribute('tabindex')) {
          /* Keyboard users get the same reveal as a mouse. */
          card.setAttribute('tabindex', '0');
        }
      }
    })(cards[c]);
  } catch (e) {}

  /* A width change can turn a card that fitted into one that clips, so
     the decision above is re-taken after a resize settles. */
  try {
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        var ps = document.querySelectorAll('.hcard p, .cell p');
        for (var i = 0; i < ps.length; i++) {
          var pel = ps[i], cd = pel.parentNode.querySelector('.more');
          if (!pel.classList.contains('clamp') && cd) {
            pel.classList.add('clamp');
            if (pel.scrollHeight - pel.clientHeight <= 4) pel.classList.remove('clamp');
          }
        }
      }, 220);
    }, { passive: true });
  } catch (e) {}

  /* The showcase carousel's driver lived here. The homepage now shows all
     four steps at once, so there is nothing to advance. */

/* ── Hero mesh ───────────────────────────────────────────
     Points drift across the hero and join up where they are close; the
     cursor pushes the nearby ones aside. The same idea as the mesh on
     codeiqholdings.co.uk, in ContractIQ's colours: pale blue threads over
     the photograph, teal on the few "live" points.

     Three things keep it honest. It is skipped entirely under
     prefers-reduced-motion. It stops drawing when the hero scrolls out of
     view, so it costs nothing on the rest of the page. And it is purely
     decorative — aria-hidden, pointer-events:none, injected by script —
     so with JavaScript off the hero is exactly as it was.
     Kept inside its own function so its names cannot reach the rest of
     this file: `mx` and `my` already belong to the hero parallax, and
     sharing them threw the background photograph several thousand
     pixels off screen. */
  (function () {
    try {
      var heroEl = document.querySelector('.hero, .page-hero');
      if (heroEl && !reduce && typeof requestAnimationFrame === 'function') {
        var cv = document.createElement('canvas');
        cv.className = 'ciq-mesh';
        cv.setAttribute('aria-hidden', 'true');
        var ctx = cv.getContext && cv.getContext('2d');
        if (ctx) {
          heroEl.insertBefore(cv, heroEl.firstChild);
  
          var LINE = '194,215,238';   /* --mist, the pale blue of the range */
          var HOT  = '69,214,198';    /* --teal, the accent                 */
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          var pts = [], W = 0, H = 0, raf = null, mx = -9999, my = -9999, running = false;
  
          var resize = function () {
            var r = heroEl.getBoundingClientRect();
            W = r.width; H = r.height;
            if (!W || !H) return;
            cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            /* Fewer points on a phone: this runs every frame, and a hero that
               drains a battery is worse than a hero that sits still. */
            var cap = W < 760 ? 34 : 78;
            var n = Math.max(20, Math.min(cap, Math.round((W * H) / 19000)));
            pts = [];
            for (var i = 0; i < n; i++) {
              pts.push({ x: Math.random() * W, y: Math.random() * H,
                         vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
                         r: Math.random() * 1.4 + 0.6, hot: Math.random() < 0.16 });
            }
          };
  
          var draw = function () {
            raf = null;
            if (W && H) {
              ctx.clearRect(0, 0, W, H);
              var link = Math.min(190, W * 0.17), i, p;
              for (i = 0; i < pts.length; i++) {
                p = pts[i];
                p.x += p.vx; p.y += p.vy;
                if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
                if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
                var dx = p.x - mx, dy = p.y - my, d = Math.sqrt(dx * dx + dy * dy);
                p.px = p.x; p.py = p.y;
                if (d < 170 && d > 0) {
                  var f = (170 - d) / 170 * 24;
                  p.px += (dx / d) * f; p.py += (dy / d) * f;
                }
              }
              for (var a = 0; a < pts.length; a++) {
                for (var b = a + 1; b < pts.length; b++) {
                  var ex = pts[a].px - pts[b].px, ey = pts[a].py - pts[b].py;
                  var ed = Math.sqrt(ex * ex + ey * ey);
                  if (ed < link) {
                    var o = (1 - ed / link) * 0.30;
                    ctx.strokeStyle = (pts[a].hot || pts[b].hot)
                      ? 'rgba(' + HOT + ',' + (o * 0.9).toFixed(3) + ')'
                      : 'rgba(' + LINE + ',' + (o * 0.5).toFixed(3) + ')';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(pts[a].px, pts[a].py);
                    ctx.lineTo(pts[b].px, pts[b].py);
                    ctx.stroke();
                  }
                }
              }
              for (i = 0; i < pts.length; i++) {
                p = pts[i];
                ctx.beginPath();
                ctx.arc(p.px, p.py, p.r, 0, Math.PI * 2);
                ctx.fillStyle = p.hot ? 'rgba(' + HOT + ',.85)' : 'rgba(' + LINE + ',.42)';
                ctx.fill();
              }
            }
            if (running) raf = requestAnimationFrame(draw);
          };
  
          var start = function () { if (!running) { running = true; if (!raf) raf = requestAnimationFrame(draw); } };
          var stop  = function () { running = false; if (raf) { cancelAnimationFrame(raf); raf = null; } };
  
          resize();
          var meshRT;
          window.addEventListener('resize', function () {
            clearTimeout(meshRT);
            meshRT = setTimeout(function () { resize(); if (running && !raf) raf = requestAnimationFrame(draw); }, 180);
          }, { passive: true });
          window.addEventListener('mousemove', function (e) {
            var r = cv.getBoundingClientRect();
            mx = e.clientX - r.left; my = e.clientY - r.top;
          }, { passive: true });
          window.addEventListener('mouseout', function () { mx = -9999; my = -9999; }, { passive: true });
  
          if ('IntersectionObserver' in window) {
            new IntersectionObserver(function (es) {
              for (var k = 0; k < es.length; k++) { if (es[k].isIntersecting) { start(); } else { stop(); } }
            }, { threshold: 0.01 }).observe(cv);
          }
          start();
        }
      }
    } catch (e) {}
  })();

/* ── ROI calculator, where present ───────────────────────── */
  try {
    var spend = document.getElementById('spend');
    if (spend) {
      var gbp = function (n) { return '£' + Math.round(n).toLocaleString('en-GB'); };
      var paint = function () {
        var v = +spend.value;
        spend.style.setProperty('--pct', ((v - spend.min) / (spend.max - spend.min) * 100) + '%');
        var set = function (id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; };
        set('spendOut', gbp(v));
        set('c3', gbp(v * 0.03));
        set('c6', gbp(v * 0.06));
        set('mult', Math.round(v * 0.03 / 948) + '×');
      };
      spend.addEventListener('input', paint);
      paint();
    }
  } catch (e) {}
})();
