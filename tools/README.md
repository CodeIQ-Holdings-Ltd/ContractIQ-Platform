# v14 — the homepage showcase

Replaces the four-slide carousel on `index.html` with four stacked bands, each
carrying a large heading and a screenshot of the real application.

## Why this is a patch rather than a full build

The session that made this had the **v12** site in front of it, not v13. Handing
you a whole `ContractIQ_v14.zip` built on v12 would have quietly undone the
Bedrock routing, the Sandbox 150 → 100 credit change, Legal Centre 1.1 and the
MIGRATION_007 privilege fixes. So this changes only the two files the showcase
touches, and refuses to run if it does not recognise what it finds.

## Applying it to v13

Copy the `tools/` folder and `assets/shots/` into your v13 site folder, then:

```
cd "ContractIQ_v13"
python3 tools/apply_flow.py
```

It anchors on marker comments rather than line numbers, so it does not care
that v13's `index.html` differs from v12's elsewhere. It will stop without
writing anything if:

- the file already contains the showcase (`fshow`),
- either carousel marker is missing or appears twice,
- any carousel class survives the swap,
- the JavaScript block it finds does not look like the carousel driver.

If it aborts, nothing has changed and the message says which check failed.

### What it changes

| File | Change |
|---|---|
| `index.html` | carousel CSS block → flow showcase CSS; carousel markup → four bands |
| `assets/ciq-motion.js` | removes the slide driver and its eight-second auto-advance |
| `assets/shots/*.webp` | four new images, 338 KB in total |

Nothing else is touched. No other page references the carousel.

### Afterwards

```
node verify_site.mjs          # 28 checks: clipped text, invisible elements,
                              # sideways scroll at five widths, JS-off reading
node verify_consistency.mjs
node verify_text_claims.mjs
```

## Re-shooting the screenshots

The captures come from the demo build, so they will drift as the app changes.
To redo them:

```
node tools/shoot_app.mjs      # writes shots-raw/
node tools/shoot_cedric.mjs   # the Cedric panel on its own
python3 tools/crop_shots.py   # crops, compresses, writes assets/shots/
```

Three things in there are deliberate and worth keeping:

- **The app is captured at an 820px viewport, not 1600.** Shrunk from a wide
  capture into a half-width column, the application's 15px type landed at about
  four pixels on screen — which is exactly what was wrong with the placeholder
  screens this replaces.
- **The top navigation strip is cropped off.** It carries the credit counter,
  which reads 150/150 in this build — the *v12* Sandbox allowance. A screenshot
  is not text, so no consistency check would ever catch a retired number there.
  Re-check this crop if the nav ever moves.
- **Cedric is captured without asking it a question.** In `DEMO_MODE` its canned
  reply says its "live AI engine is switched off to keep it free to host" —
  true of the public demo, and the last thing that belongs on a homepage. The
  greeting describes the real capability and is accurate on every build.

## Two things found while doing this, neither fixed here

1. **The app's top bar overlaps itself at ~820px.** "Ask Cedric actions" sits on
   top of the search field. Visible in `shots-raw/` on any of the raw captures;
   cropped out of the shipped images, not repaired. Worth a look since that is
   squarely in iPad width.
2. **The old slide copy said ContractIQ reads "even handwritten scans."** The
   application's own Documents tab says scanned and image-only PDFs are
   catalogued by metadata, and the Legal Centre says recognition of handwriting
   is unreliable. The new copy follows the product and the Legal Centre rather
   than the old slide.
