#!/usr/bin/env python3
"""
Swap the homepage carousel for the flow showcase.

Written as a script rather than done by hand so the same change can be
replayed against the v13 index.html on Rahul's Mac, which is ahead of the
copy in this container. It anchors on marker text rather than line numbers
and refuses to do anything if a marker is missing or ambiguous.

Run:  python3 apply_flow.py [path-to-index.html] [path-to-ciq-motion.js]
"""
import sys, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)          # tools/ sits inside the site folder
index_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SITE, "index.html")
motion_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(SITE, "assets/ciq-motion.js")

new_css = open(os.path.join(HERE, "flow.css"), encoding="utf-8").read().rstrip() + "\n\n"
new_html = open(os.path.join(HERE, "flow.html"), encoding="utf-8").read().rstrip() + "\n\n"


def cut(text, start_marker, end_marker, what):
    """Everything from start_marker up to (not including) end_marker."""
    s = text.find(start_marker)
    if s == -1:
        sys.exit(f"  ABORT: could not find the start of {what}")
    if text.find(start_marker, s + 1) != -1:
        sys.exit(f"  ABORT: {what} start marker appears more than once")
    e = text.find(end_marker, s)
    if e == -1:
        sys.exit(f"  ABORT: could not find the end of {what}")
    return s, e


html = open(index_path, encoding="utf-8").read()
if "fshow" in html:
    sys.exit("  ABORT: this file already carries the flow showcase")

# ── 1 · the stylesheet block ─────────────────────────────────────────
s, e = cut(html, "/* ── Showcase Carousel", "/* ── Process rail", "the carousel CSS")
removed_css = e - s
html = html[:s] + new_css + html[e:]

# ── 2 · the markup ───────────────────────────────────────────────────
s, e = cut(html, "<!-- ══ SHOWCASE CAROUSEL", "<!-- ══ CAPABILITIES", "the carousel markup")
removed_html = e - s
html = html[:s] + new_html + html[e:]

# Nothing should still refer to the carousel.
leftovers = [c for c in ("carousel-slide", "carousel-nav", "slide-dots", "visual-card",
                         "slide-content", "demo-icon") if c in html]
if leftovers:
    sys.exit(f"  ABORT: carousel leftovers in the page: {', '.join(leftovers)}")

open(index_path, "w", encoding="utf-8").write(html)
print(f"  index.html: -{removed_css} bytes of CSS, -{removed_html} bytes of markup, "
      f"+{len(new_css) + len(new_html)} bytes of flow showcase")

# ── 3 · the carousel's JavaScript ────────────────────────────────────
# It drove slides, dots and an eight-second auto-advance, none of which exist
# any more. Left in place it would simply never find its elements, but dead
# code that looks live is how the two-motion-system bug survived as long as it
# did, so it goes.
js = open(motion_path, encoding="utf-8").read()
s, e = cut(js, "  /* ── Showcase Carousel", "/* ── ROI calculator", "the carousel JS")
block = js[s:e]
if "setInterval(nextSlide" not in block:
    sys.exit("  ABORT: the block found does not look like the carousel code")
js = js[:s] + "".join([
    "  /* The showcase carousel's driver lived here. The homepage now shows all\n",
    "     four steps at once, so there is nothing to advance. */\n\n",
]) + js[e:]
if "goToSlide" in js:
    sys.exit("  ABORT: carousel JS still referenced after removal")
open(motion_path, "w", encoding="utf-8").write(js)
print(f"  ciq-motion.js: -{len(block)} bytes of carousel driver")
print("\n  Done.")
