#!/usr/bin/env python3
"""
Point every page at a (new) Supabase project, then rebuild the app.

You only need this if you create a NEW Supabase project — for example
because your current one is not in London. The Project URL and the
publishable key are public by design (they are what a browser is meant to
hold); the SECRET key never goes anywhere near this script.

Run, from this folder:
    python3 set_project.py https://abcdefghijklmnop.supabase.co sb_publishable_XXXXXXXX

It updates, and tells you it has updated:
    contractiq.jsx   (the app's two constants)    → then rebuilds app/ and demo/
    checkout.html    (where Stripe payments start)
    pricing.html     (the live founding-places counter)
"""
import re, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))

def fail(msg):
    sys.exit("Stopped: " + msg)

if len(sys.argv) != 3:
    fail("give the Project URL and the publishable key, in that order. See the top of this file.")
url, key = sys.argv[1].strip().rstrip("/"), sys.argv[2].strip()
if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", url):
    fail(f"{url!r} does not look like a Supabase Project URL (https://<20 letters>.supabase.co).")
if key.startswith("sb_secret_"):
    fail("that is the SECRET key. Never put it in the website. Use the publishable key (sb_publishable_…).")
if not (key.startswith("sb_publishable_") or key.count(".") == 2):
    fail("that does not look like a publishable key (sb_publishable_…).")

def edit(path, pattern, replacement, expect=1):
    p = os.path.join(HERE, path)
    s = open(p, encoding="utf-8").read()
    s2, n = re.subn(pattern, replacement, s, flags=re.M)
    if n != expect:
        fail(f"{path}: expected {expect} place(s) to change, found {n}. Nothing was saved to this file.")
    open(p, "w", encoding="utf-8").write(s2)
    print(f"  updated {path} ({n} place{'s' if n != 1 else ''})")

edit("contractiq.jsx", r'^const SUPABASE_URL = "[^"]*";', f'const SUPABASE_URL = "{url}";')
edit("contractiq.jsx", r'^const SUPABASE_PUBLISHABLE_KEY = "[^"]*";', f'const SUPABASE_PUBLISHABLE_KEY = "{key}";')
edit("checkout.html", r'var CHECKOUT_ENDPOINT = "[^"]*";', f'var CHECKOUT_ENDPOINT = "{url}/functions/v1/create-checkout-session";')
edit("pricing.html", r"var SUPABASE_URL = '[^']*';", f"var SUPABASE_URL = '{url}';")
edit("pricing.html", r"var SUPABASE_PUBLISHABLE_KEY = '[^']*';", f"var SUPABASE_PUBLISHABLE_KEY = '{key}';")

print("  rebuilding the app…")
r = subprocess.run([sys.executable, os.path.join(HERE, "build.py")], capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip())
if r.returncode != 0:
    fail("the rebuild did not finish — the pages were updated but app/index.html was not. Ask Claude to rebuild.")
print("Done. Upload the changed files to GitHub (see the go-live guide, Part D).")
