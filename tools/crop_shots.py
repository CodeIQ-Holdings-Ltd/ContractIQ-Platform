#!/usr/bin/env python3
"""
Crop and compress the raw app captures for the homepage showcase.

Captured at an 820px viewport (see shoot_app.mjs) so the interface reflows
into a compact column. Shrunk from a 1600px capture into a half-width slot on
the homepage, the application's 15px type landed at about four pixels on
screen — which is precisely what was wrong with the placeholder screens this
replaces, and worth not repeating.

Two things are deliberately cropped away:

  · The top navigation bar, which carries the credit counter. In this build it
    reads 150/150 — the v12 Sandbox allowance. v13 moved Sandbox to 100, so
    shipping that strip would put a retired number on the homepage in a form no
    text check could ever catch. (It also renders with the "Ask Cedric actions"
    link overlapping the search box at this width, which is a real responsive
    fault in the app and is noted rather than hidden.)
  · The footer and the "Demo mode" badge, true of the demo build and not of
    the product being sold.

The bottom edge is found rather than guessed: walk up from the footer through
any trailing blank page, and stop at the last row carrying content.
"""
from PIL import Image
import os

RAW, OUT = "shots-raw", "assets/shots"
os.makedirs(OUT, exist_ok=True)

LEFT, RIGHT, TOP = 40, 1600, 215      # content column, below the nav
PAGE = (255, 255, 255)                # the app's page ground
TARGET_W = 1100


def content_bottom(im, start):
    """First row of the footer, then back up over any blank page above it."""
    w, h = im.size
    y = start
    while y < h:
        row = [im.getpixel((x, y)) for x in range(LEFT + 20, RIGHT - 20, 40)]
        if sum(sum(p) for p in row) / len(row) < 200:     # the dark footer
            break
        y += 4
    while y > start:
        row = [im.getpixel((x, y - 1)) for x in range(LEFT + 20, RIGHT - 20, 24)]
        if any(abs(sum(p) - sum(PAGE)) > 18 for p in row):
            break
        y -= 4
    return y


JOBS = [("03-tab-documents.png", "ingest"),
        ("03-tab-cost.png", "extract"),
        ("03-tab-insights.png", "export")]

for src, name in JOBS:
    im = Image.open(os.path.join(RAW, src)).convert("RGB")
    bottom = content_bottom(im, TOP + 400) + 26          # a little breathing room
    im = im.crop((LEFT, TOP, RIGHT, min(bottom, im.size[1])))
    w, h = im.size
    im = im.resize((TARGET_W, round(h * TARGET_W / w)), Image.LANCZOS)
    path = os.path.join(OUT, f"{name}.webp")
    im.save(path, "WEBP", quality=86, method=6)
    print(f"  {name}.webp  {im.size[0]}x{im.size[1]}  {os.path.getsize(path)/1024:.0f} KB")

# Cedric is captured as its own element by shoot_cedric.mjs, because cropping a
# rectangle out of the page sliced words in half down the left edge. The panel
# is viewport-height, so a band of empty chat sits between the greeting and the
# suggested questions; that slice is a single flat colour and is removed here
# rather than shipped as dead space.
src = os.path.join(RAW, "cedric-panel.png")
if os.path.exists(src):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    TOP_C, BOT_C = 620, 835
    band = {im.getpixel((x, y)) for y in range(TOP_C + 5, BOT_C - 5, 20)
            for x in range(40, w - 40, 60)}
    if len(band) != 1:
        raise SystemExit(f"  refusing to splice: rows {TOP_C}-{BOT_C} are not flat ({len(band)} colours)")
    out = Image.new("RGB", (w, TOP_C + (h - BOT_C)))
    out.paste(im.crop((0, 0, w, TOP_C)), (0, 0))
    out.paste(im.crop((0, BOT_C, w, h)), (0, TOP_C))
    path = os.path.join(OUT, "cedric.webp")
    out.save(path, "WEBP", quality=88, method=6)
    print(f"  cedric.webp  {out.size[0]}x{out.size[1]}  {os.path.getsize(path)/1024:.0f} KB")

total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) / 1024
print(f"\n  total {total:.0f} KB")
