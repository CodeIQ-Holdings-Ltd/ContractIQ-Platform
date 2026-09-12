"""Rename the product to "ContractIQ Platform" and set the new domain.

Two decisions worth recording:

1. "ContractIQ Hub" goes too. It was the marketing site's name while
   "ContractIQ App" was the product. On a domain called
   contractiqplatform.co.uk, keeping Hub would leave three competing
   names for one thing. Everything becomes "ContractIQ Platform".

2. The /app/ URL path stays. It is infrastructure, not branding: nobody
   reads it as a product name, contractiqplatform.com/platform/ would be
   absurdly redundant, and renaming it would break the GitHub Pages
   deployment and every existing link for no gain.

Run with a different domain to change it again:
    python3 rename_to_platform.py contractiqplatform.com
"""
import sys, os, glob, re

SITE = "/home/claude/site"
JSX = "/mnt/user-data/outputs/contractiq.jsx"
DOMAIN = sys.argv[1] if len(sys.argv) > 1 else "contractiqplatform.co.uk"

# Order matters: the longest, most specific strings first, so a broad
# replacement cannot eat a narrower one.
SUBS = [
    # Branding
    ("ContractIQ App",  "ContractIQ Platform"),
    ("ContractIQ Hub",  "ContractIQ Platform"),
    ("Contract<span>IQ</span> App",  "Contract<span>IQ</span> Platform"),
    ("Contract<span>IQ</span> Hub",  "Contract<span>IQ</span> Platform"),
    # Old domain from the previous legal pass
    ("contractiq.co.uk", DOMAIN),
]

def apply(text):
    n = 0
    for old, new in SUBS:
        c = text.count(old)
        if c:
            text = text.replace(old, new)
            n += c
    return text, n

total = 0
touched = {}

for path in sorted(glob.glob(os.path.join(SITE, "*.html"))):
    t = open(path).read()
    t, n = apply(t)
    if n:
        open(path, "w").write(t)
        touched[os.path.basename(path)] = n
        total += n

# The app source, then it gets recompiled.
t = open(JSX).read()
t, n = apply(t)
if n:
    open(JSX, "w").write(t)
    touched["contractiq.jsx"] = n
    total += n

print(f"  domain: {DOMAIN}")
print(f"  {total} replacements across {len(touched)} files\n")
for f, n in sorted(touched.items()):
    print(f"    {f:22} {n}")

# What is left, and is it meant to be there?
print()
leftovers = []
for path in sorted(glob.glob(os.path.join(SITE, "*.html"))) + [JSX]:
    t = open(path).read()
    for m in re.finditer(r"ContractIQ (App|Hub)", t):
        leftovers.append((os.path.basename(path), m.group(0)))
print(f"  branding leftovers: {len(leftovers)}")
for f, m in leftovers[:8]:
    print(f"    {f}: {m}")

paths = sum(len(re.findall(r'href="app/', open(p).read())) for p in glob.glob(os.path.join(SITE, "*.html")))
print(f"\n  /app/ links left intact: {paths}  (deliberate — path, not branding)")
