"""Stamp the operating entity's real details into the legal pages.

Written as a script rather than a one-off edit so it can be re-run the
moment anything changes — a new domain, a registered-office service, or a
different company. Run it again and every page updates together, which is
how the three documents stay consistent with each other.

    python3 set_legal_details.py                    # uses the values below
    python3 set_legal_details.py contractiq.co.uk   # override just the domain
"""
import sys, re, glob, os

# ── The operating entity ──────────────────────────────────────
COMPANY   = "Rita Baxi Limited"
COMPANY_NO = "10885786"
ADDRESS   = "103 Battalion Drive, Wootton, Northampton, NN4 6RX, United Kingdom"
TRADING   = "ContractIQ"          # the brand customers see
DOMAIN    = sys.argv[1] if len(sys.argv) > 1 else "contractiq.co.uk"

LEGAL_EMAIL   = f"legal@{DOMAIN}"
PRIVACY_EMAIL = f"privacy@{DOMAIN}"
DPO_EMAIL     = f"privacy@{DOMAIN}"

SITE = sys.argv[2] if len(sys.argv) > 2 else "/home/claude/site"

# Longest first, so a broader pattern cannot eat a narrower one.
SUBS = [
    ("[ContractIQ Ltd, address]",
     f"{COMPANY} (trading as {TRADING}), {ADDRESS}"),
    ("[ContractIQ Ltd]",   COMPANY),
    ("[company number]",   f"company number {COMPANY_NO}"),
    ("[address]",          ADDRESS),
    ("[legal@yourdomain.com]",   LEGAL_EMAIL),
    ("[privacy@yourdomain.com]", PRIVACY_EMAIL),
    ("[dpo@yourdomain.com]",     DPO_EMAIL),
]

changed = {}
for path in sorted(glob.glob(os.path.join(SITE, "*.html"))):
    t = open(path).read()
    before = t
    for old, new in SUBS:
        t = t.replace(old, new)
    # Any leftover mailto/contact placeholders on the same pattern
    t = t.replace("yourdomain.com", DOMAIN)
    if t != before:
        open(path, "w").write(t)
        changed[os.path.basename(path)] = sum(before.count(o) for o, _ in SUBS)

print(f"  entity : {COMPANY} ({COMPANY_NO})")
print(f"  address: {ADDRESS}")
print(f"  domain : {DOMAIN}")
print()
for f, n in changed.items():
    print(f"  {f}: {n} placeholder(s) filled")

# Report anything still unresolved, excluding CSS selectors like [open]
print()
CSS_OK = {"open", "type=text", "href", "class"}
left = []
for path in sorted(glob.glob(os.path.join(SITE, "*.html"))):
    t = open(path).read()
    for m in re.findall(r"\[([^\]\[<>]{3,80})\]", t):
        if m.strip() in CSS_OK or m.startswith(("data-", "aria-")):
            continue
        left.append((os.path.basename(path), m))
if left:
    print("  STILL UNRESOLVED:")
    for f, m in left:
        print(f"    {f}: [{m}]")
else:
    print("  no unresolved placeholders remain")
