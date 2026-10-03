#!/usr/bin/env python3
"""
ContractIQ — the profit model, and the document it produces.

WHY THIS IS A SCRIPT AND NOT A SPREADSHEET OR A HAND-WRITTEN TABLE

The previous version of PROFIT_SCENARIOS.md was written by hand. Its six
scenarios were recalculated at one point and the rest of the document was
not, so the summary, the trajectory table, the breakeven analysis, the
annual projection and the conclusion all carried figures from an earlier
model. It contradicted itself in eight places and was priced at £199 for
Scale, a price retired in September.

Every number in the generated document now comes from this one file. If a
price changes, change it here and regenerate — nothing is typed twice.

Run:  python3 model_profit.py        (writes PROFIT_SCENARIOS.md)
      python3 model_profit.py --check (asserts the model, writes nothing)
"""

import sys

# ── Prices, from plan_catalogue in MIGRATION_004 — the source of truth ──
GROWTH = 79.00
SCALE = 270.00
ENTERPRISE = 700.00
BOLTON_PRICE, BOLTON_CREDITS = 25.00, 100

# ── Credit allowances, from plan_catalogue ──
CREDITS = {"growth": 500, "scale": 1800}

# ── Variable cost inputs ──
# Stripe UK published rate for domestic cards. International cards are
# dearer (3.25% + 20p), so the blend assumes 85% UK / 15% international.
STRIPE_UK_PCT, STRIPE_INTL_PCT, STRIPE_FIXED = 0.015, 0.0325, 0.20
UK_SHARE = 0.85
STRIPE_PCT = UK_SHARE * STRIPE_UK_PCT + (1 - UK_SHARE) * STRIPE_INTL_PCT

# AI cost per credit, on Amazon Bedrock's EU route (Claude Sonnet 5 at
# $2.20 in / $11 out per million tokens — list price plus the 10% regional
# premium — at $1.34 to the pound, 19 Sept 2026). Worked from token counts:
# a typical analysis (documents clipped at 55,000 characters, five stages)
# is about £0.26 before caching, so £0.026 a credit. The worst case — every
# stage hitting its 8,000-token output ceiling — is about £0.46, £0.046 a
# credit, and that is the sensitivity. Caching the documents across the
# five stages brings the typical case nearer £0.18; the model deliberately
# does not bank that saving.
#
# The old £0.006 figure was about four times too low; GOING_LIVE.md's
# ~£0.23 per contract was close to right. Settle it from the first AWS bill.
AI_PER_CREDIT = 0.026
AI_PER_CREDIT_HIGH = 0.046

# Failed payments and refunds, as a share of gross.
REFUND_RATE = 0.01

# ── The cost of running it ──
# Split deliberately into cash that leaves the bank, and the cost of the
# human being. Conflating the two is how the previous model ended up with
# £2,340/month of "fixed costs" that nobody could point at.
CASH_COSTS = [
    ("Supabase Pro", 20.00, "$25/month. Already held."),
    ("Domains (two, .co.uk and .com)", 2.00, "~£20/year each, at cost registrars."),
    ("Website and app hosting", 0.00, "GitHub Pages, including TLS."),
    ("Transactional email (SMTP)", 15.00, "Needed before ten sign-ups land in one evening."),
    ("ICO registration", 4.33, "£52/year, statutory."),
    ("Registered office service", 4.00, "~£48/year. Keeps a home address off the Terms."),
    ("Professional indemnity insurance", 37.50, "~£450/year for a small SaaS."),
    ("Accountancy and filings", 62.50, "~£750/year for a small limited company."),
    ("Error tracking and uptime monitoring", 0.00, "Free tiers are sufficient at this size."),
]

# Support and maintenance, as a monthly cost of someone's time. This is
# the number that decides where breakeven falls, so it is stated on its
# own rather than folded into a total.
def people_cost(users: int) -> float:
    if users <= 15:
        return 1_400.00   # founder-equivalent, part time
    if users <= 35:
        return 1_800.00   # more support load, same person, more hours
    if users <= 55:
        return 2_600.00   # first part-time help
    return 3_400.00       # part-time help becomes most of a role

CASH_TOTAL = sum(c for _, c, _ in CASH_COSTS)

# ── The adoption mix ──
# Growth is the entry point; Scale grows as a share as the product proves
# itself. Enterprise is excluded from every scenario: it is not self-serve,
# it is sold with a conversation, and a model that leans on one £700 seat
# to reach breakeven is telling you nothing useful.
MIX = {
    10: (8, 2),
    12: (8, 4),
    20: (12, 8),
    30: (17, 13),
    40: (22, 18),
    50: (26, 24),
    60: (30, 30),
}


def scenario(users: int, ai_per_credit: float = AI_PER_CREDIT) -> dict:
    growth, scale = MIX[users]
    assert growth + scale == users, f"mix for {users} does not sum to {users}"

    gross = growth * GROWTH + scale * SCALE

    stripe = gross * STRIPE_PCT + users * STRIPE_FIXED
    refunds = gross * REFUND_RATE
    # Costed at FULL utilisation: every customer spends their whole
    # allowance. Real usage is lower, so this is the floor of the margin,
    # not the middle of it.
    ai = (growth * CREDITS["growth"] + scale * CREDITS["scale"]) * ai_per_credit
    variable = stripe + refunds + ai

    net = gross - variable
    people = people_cost(users)
    fixed = CASH_TOTAL + people
    profit = net - fixed

    return {
        "users": users, "growth": growth, "scale": scale,
        "gross": gross, "stripe": stripe, "refunds": refunds, "ai": ai,
        "variable": variable, "net": net,
        "cash": CASH_TOTAL, "people": people, "fixed": fixed,
        "profit": profit,
        "margin": profit / gross * 100 if gross else 0.0,
        "arpu": gross / users if users else 0.0,
    }


def breakeven_users(ai_per_credit: float = AI_PER_CREDIT) -> int:
    """The first user count in the modelled mix that turns a profit."""
    for n in sorted(MIX):
        if scenario(n, ai_per_credit)["profit"] > 0:
            return n
    return -1


def money(x: float) -> str:
    """Whole pounds, with the minus sign outside the symbol."""
    return f"{'-' if x < 0 else ''}£{abs(x):,.0f}"


def pence(x: float) -> str:
    """For values under a pound, where rounding to whole pounds says £0."""
    return f"{x * 100:.0f}p"


def check() -> None:
    """Assertions that would have caught every fault in the old document."""
    problems = []

    for n in sorted(MIX):
        s = scenario(n)
        g, sc = MIX[n]
        if g + sc != n:
            problems.append(f"mix for {n} users sums to {g + sc}")
        recomputed = g * GROWTH + sc * SCALE
        if abs(s["gross"] - recomputed) > 0.01:
            problems.append(f"gross at {n} users does not match the mix")
        if abs((s["net"] - s["fixed"]) - s["profit"]) > 0.01:
            problems.append(f"profit at {n} users is not net minus fixed")
        if abs((s["gross"] - s["variable"]) - s["net"]) > 0.01:
            problems.append(f"net at {n} users is not gross minus variable")

    # At the Bedrock EU cost (£0.026 a credit, full utilisation) twelve
    # users no longer covers the person running it; twenty does. The old
    # model said twelve only because it priced AI four times too cheaply.
    be = breakeven_users()
    if be != 20:
        problems.append(f"breakeven falls at {be} users, not 20")
    if scenario(12)["profit"] >= 0:
        problems.append("12 users should still be a loss at full utilisation")
    if scenario(20)["profit"] <= 0:
        problems.append("20 users should be profitable")

    # Monotonic: more users must never mean less profit, or the mix is wrong.
    profits = [scenario(n)["profit"] for n in sorted(MIX)]
    if profits != sorted(profits):
        problems.append("profit is not monotonic across the scenarios")

    if problems:
        for p in problems:
            print(f"  FAIL  {p}")
        sys.exit(1)
    print(f"  All model checks passed. Breakeven at {be} users.")


def document() -> str:
    rows = [scenario(n) for n in sorted(MIX)]
    be = breakeven_users()
    s12, s60 = scenario(12), scenario(60)
    sbe = scenario(be)
    hi60 = scenario(60, AI_PER_CREDIT_HIGH)
    hi_be = breakeven_users(AI_PER_CREDIT_HIGH)

    out = []
    w = out.append

    w("# ContractIQ — profit scenarios\n")
    w("**Prices:** Growth £79, Scale £270 a month, as held in `plan_catalogue`. ")
    w("**Currency:** GBP. **Generated by:** `model_profit.py`.\n")
    w("> Every figure in this document is produced by `model_profit.py`. Nothing is typed by hand, "
      "because the previous version of this document was, and its summary, tables and conclusion "
      "ended up describing three different models at a price that had been retired. "
      "To change an assumption, change the script and regenerate.\n")

    w("\n## The short answer\n")
    w(f"The business covers its costs at **{be} users** on the adoption mix below, and every ")
    w(f"additional customer after that is close to pure contribution. At {be} users it makes ")
    w(f"{money(sbe['profit'])} a month; at 60 it makes {money(s60['profit'])} a month on ")
    w(f"{money(s60['gross'])} of billings, a margin of {s60['margin']:.0f}%.\n")
    w("\nThat breakeven point is not a fact about hosting. Hosting and compliance together come to ")
    w(f"{money(CASH_TOTAL)} a month, which two Growth customers would cover. Breakeven sits at ")
    w(f"{be} because the model pays for the support and maintenance the product actually needs — ")
    w(f"{money(people_cost(12))} a month at this size. **{be} users is the point at which ContractIQ ")
    w("stops depending on unpaid evenings.** If you are content to keep absorbing that yourself, the ")
    w(f"business is cash-positive from roughly the third customer; the honest number is the one below.\n")

    w("\n## What it costs to run\n")
    w("### Cash out of the bank\n")
    w("| Item | Monthly | Note |\n|---|---:|---|\n")
    for name, cost, note in CASH_COSTS:
        w(f"| {name} | {money(cost)} | {note} |\n")
    w(f"| **Total cash costs** | **{money(CASH_TOTAL)}** | Does not scale with users at this size |\n")

    w("\n### The cost of the person\n")
    w("Support, bug fixes, onboarding and the small unglamorous maintenance that keeps a product ")
    w("working. Stated separately because it is the number that decides where breakeven falls, and ")
    w("because burying it in a total is how a model flatters itself.\n\n")
    w("| Users | Monthly | What it buys |\n|---|---:|---|\n")
    w(f"| Up to 15 | {money(people_cost(10))} | Founder-equivalent, part time |\n")
    w(f"| 16–35 | {money(people_cost(20))} | Same person, more hours |\n")
    w(f"| 36–55 | {money(people_cost(40))} | First part-time help |\n")
    w(f"| 56+ | {money(people_cost(60))} | Support becomes most of a role |\n")

    w("\n### Costs that move with revenue\n")
    w(f"- **Card processing** — {STRIPE_PCT * 100:.2f}% plus {pence(STRIPE_FIXED)} a transaction. ")
    w(f"Stripe's UK rate is {STRIPE_UK_PCT * 100:.1f}% + {pence(STRIPE_FIXED)} on domestic cards and ")
    w(f"{STRIPE_INTL_PCT * 100:.2f}% + {pence(STRIPE_FIXED)} on international ones; the blend assumes ")
    w(f"{UK_SHARE:.0%} domestic.\n")
    w(f"- **Refunds and failed payments** — {REFUND_RATE:.0%} of billings, as a working buffer.\n")
    w(f"- **AI inference** — £{AI_PER_CREDIT:.3f} per credit, costed at **full utilisation**: every ")
    w("customer is assumed to spend their entire allowance every month. Real usage is lower, so the ")
    w("margins below are a floor rather than a midpoint.\n")

    w("\n> **Where the AI figure comes from.** Amazon Bedrock's EU route, Claude Sonnet 5, $2.20 in and ")
    w("$11 out per million tokens (list price plus the 10% regional premium), at $1.34 to the pound. A ")
    w(f"typical analysis works out at about £0.26 before caching — £{AI_PER_CREDIT:.3f} a credit. The ")
    w("earlier £0.006 figure was about four times too low. Caching the documents across the five ")
    w("stages brings a typical analysis nearer £0.18, a saving this model does not bank. The ")
    w(f"sensitivity section runs the worst case, £{AI_PER_CREDIT_HIGH:.3f} a credit. Confirm against ")
    w("the first AWS bill.\n")

    w("\n## The scenarios\n")
    w("| Users | Growth | Scale | Gross | Card fees | Refunds | AI | Net | Cash costs | People | Profit | Margin |\n")
    w("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for r in rows:
        w(f"| **{r['users']}** | {r['growth']} | {r['scale']} | {money(r['gross'])} | "
          f"{money(r['stripe'])} | {money(r['refunds'])} | {money(r['ai'])} | {money(r['net'])} | "
          f"{money(r['cash'])} | {money(r['people'])} | "
          f"{'**' + money(r['profit']) + '**' if r['profit'] > 0 else money(r['profit'])} | "
          f"{r['margin']:.0f}% |\n")

    w("\n### Reading the turn\n")
    s10 = scenario(10)
    w(f"- **10 users** — {money(s10['profit'])} a month. This is the founding cohort converting to ")
    w("paid plans. It is a loss, and a small enough one to be worth carrying for the reference ")
    w("customers and the first real accuracy measurements.\n")
    w(f"- **12 users** — {money(s12['profit'])}. Close, but at full utilisation still short of paying ")
    w("for the person running it. (At the old, too-cheap AI figure this was the breakeven point.)\n")
    w(f"- **{be} users** — {money(sbe['profit'])}. The first modelled month the business pays for itself, ")
    w("including the person running it.\n")
    for n in (30, 40, 60):
        r = scenario(n)
        w(f"- **{n} users** — {money(r['profit'])} a month at a {r['margin']:.0f}% margin.\n")
    w("\nThe steps down in margin at 40 and 60 users are the support cost stepping up, not the ")
    w("product getting worse. Each step is a decision to make before the load arrives, not after.\n")

    w("\n## Why the mix matters more than the count\n")
    w(f"A Scale customer bills {SCALE / GROWTH:.1f}× a Growth customer and costs very little more to ")
    w(f"serve — {money(CREDITS['scale'] * AI_PER_CREDIT)} of inference a month at full use against ")
    w(f"{money(CREDITS['growth'] * AI_PER_CREDIT)}.\n\n")
    w("| If 12 customers were… | Gross | Profit |\n|---|---:|---:|\n")
    for g, sc in ((12, 0), (8, 4), (6, 6), (0, 12)):
        gr = g * GROWTH + sc * SCALE
        var = gr * STRIPE_PCT + 12 * STRIPE_FIXED + gr * REFUND_RATE + \
            (g * CREDITS["growth"] + sc * CREDITS["scale"]) * AI_PER_CREDIT
        pf = gr - var - CASH_TOTAL - people_cost(12)
        w(f"| {g} Growth, {sc} Scale | {money(gr)} | {money(pf)} |\n")
    g12 = 12 * GROWTH - (12 * GROWTH * (STRIPE_PCT + REFUND_RATE) + 12 * STRIPE_FIXED + 12 * CREDITS["growth"] * AI_PER_CREDIT) - CASH_TOTAL - people_cost(12)
    sc12 = 12 * SCALE - (12 * SCALE * (STRIPE_PCT + REFUND_RATE) + 12 * STRIPE_FIXED + 12 * CREDITS["scale"] * AI_PER_CREDIT) - CASH_TOTAL - people_cost(12)
    w(f"\nTwelve Growth customers lose {money(-g12)} a month. Twelve Scale customers make {money(sc12)}. **Moving one customer from Growth to Scale is worth roughly as much as winning two more ")
    w("Growth customers**, which is an argument for where the selling effort goes.\n")

    w("\n## Sensitivity\n")
    w(f"**If every analysis hit the worst case** (£{AI_PER_CREDIT_HIGH:.3f} per credit — every stage at ")
    w(f"its output ceiling, every credit spent): breakeven moves to **{hi_be} users**, and 60 users yields ")
    w(f"{money(hi60['profit'])} rather than {money(s60['profit'])}. The model survives it. ")
    w("That is the useful finding: the business is not sensitive to being wrong about inference cost.\n\n")
    w("**If nobody upgrades and every customer stays on Growth:** see the mix table above — ")
    w("breakeven moves out beyond 20 users. This is the risk that actually matters.\n\n")
    w(f"**If card fees were the US rate** (2.9% + £0.30 rather than the UK {STRIPE_UK_PCT * 100:.1f}% + {pence(STRIPE_FIXED)}): ")
    extra = s60["gross"] * (0.029 - STRIPE_PCT) + 60 * (0.30 - STRIPE_FIXED)
    w(f"about {money(extra)} a month more at 60 users. Worth knowing, not worth planning around.\n")

    w("\n## Unit economics at 60 users\n")
    w("| Measure | Value |\n|---|---:|\n")
    w(f"| Average revenue per user | {money(s60['arpu'])} a month |\n")
    w(f"| Variable cost per user | {money(s60['variable'] / 60)} a month |\n")
    w(f"| Contribution per user | {money((s60['gross'] - s60['variable']) / 60)} a month |\n")
    w(f"| Contribution margin | {(s60['gross'] - s60['variable']) / s60['gross'] * 100:.0f}% |\n")
    w(f"| Net margin after all costs | {s60['margin']:.0f}% |\n")
    w(f"| Annualised billings | {money(s60['gross'] * 12)} |\n")
    w(f"| Annualised profit | {money(s60['profit'] * 12)} |\n")
    w("\nA customer retained two years is worth roughly ")
    w(f"{money((s60['gross'] - s60['variable']) / 60 * 24)} in contribution, so acquisition can be ")
    w("expensive and still pay back inside a quarter. That figure assumes the retention; nothing is ")
    w("yet known about churn, because nothing has yet been sold.\n")

    w("\n## What this model does not know\n")
    w("- **Churn.** Assumed zero. It will not be. Every point of monthly churn pushes each milestone ")
    w("further out, and at 5% a month the 60-user scenario never arrives without roughly three new ")
    w("customers a month just to stand still.\n")
    w("- **Acquisition cost.** No marketing spend is modelled at all. If customers cost £300 each to ")
    w("win, reaching 60 users costs £18,000 that appears nowhere above.\n")
    w("- **VAT.** Not modelled. Registration becomes compulsory above the threshold, and for ")
    w("VAT-registered business customers it is broadly neutral — but it is not nothing to administer.\n")
    w("- **Enterprise.** Excluded deliberately. It is not self-serve, and a model that reaches ")
    w("breakeven on one £700 seat is a model that tells you nothing.\n")
    w("- **Accuracy.** No accuracy figure has been measured against a labelled reference set. If the ")
    w("first ten customers find the analysis unreliable, no part of this document matters.\n")
    return "".join(out)


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
    else:
        check()
        with open("PROFIT_SCENARIOS.md", "w", encoding="utf-8") as fh:
            fh.write(document())
        print("  PROFIT_SCENARIOS.md written.")
