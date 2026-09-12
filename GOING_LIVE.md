# Going live — domain, hosting, email, payments

Written for Rita Baxi Limited (company 10885786) trading as ContractIQ Platform,
at contractiqplatform.co.uk and contractiqplatform.com.

---

## Read this first

You are about to trade through **your wife's company**. That is a normal,
sensible thing to do — but it has consequences worth being deliberate
about, because the legal documents I have just filled in now name Rita
Baxi Limited as the party your customers contract with.

**1. Can you bind the company?**
Check the People tab on Companies House. If Rita is the sole director,
then legally she is the one entering into every customer contract, and
she carries the liability for a product she did not build. Two fixes,
either is fine: appoint yourself as a director (free, ten minutes on
Companies House), or get her written authority to act. Do one of them
before you take a penny.

**2. Your home address becomes public.**
103 Battalion Drive appears in the Terms, the Privacy Policy, and on your
website. It is already on Companies House, but a website invites a
different kind of attention. A registered office service costs about
£40–60 a year and gives you a business address for both. Worth it.

**3. You must register with the ICO.**
This is not optional. A UK company processing personal data has to
register with the Information Commissioner's Office. Contracts contain
names and signatures; meeting transcripts contain voices and opinions.
That is squarely personal data. It costs **£52 a year** for a small
organisation and takes about fifteen minutes at ico.org.uk/registration.

Your Privacy Policy currently carries a red placeholder for the
registration number. Fill it in once you have it. Publishing a privacy
policy that claims UK GDPR compliance while unregistered is the kind of
detail a procurement due-diligence questionnaire will catch.

**4. The SIC code does not cover software.**
82110 is "combined office administrative service activities". Add
**62012** (business and domestic software development) at the next
confirmation statement. Free, and it matters if anyone checks.

**5. Insurance.**
Whatever cover Rita Baxi Limited has today almost certainly does not
extend to a software product that gives commercial advice on contracts.
Professional indemnity for a small SaaS runs roughly £300–600 a year.
Not needed to test. Needed before you invoice.

---

## Hosting: you already have it, and it is free

You do not need to buy hosting. GitHub Pages serves your site and app,
supports a custom domain, and issues a free HTTPS certificate. That is
what you are already using.

| | Cost |
|---|---|
| GitHub Pages | £0 |
| Supabase (database + functions) | £0 on the free tier |
| Anthropic API | ~£0.23 per contract analysed |
| **Domain** | **~£8–11 a year** |
| Email | £0 |

The only thing you actually need to buy is the domain.

---

## Step 1 · Buy the domain — DONE

You own contractiqplatform.co.uk and contractiqplatform.com.
What follows still applies for renewals and for the second domain.

### Reference: choosing a registrar

**Where.** Use a registrar that charges the same at renewal as at
registration. The trap is a £1 first year that becomes £22 forever after.

- **Cloudflare Registrar** — sells at cost, about $9.77/year for a .com,
  free WHOIS privacy. Cheapest honest option. Does not sell every
  extension, so check .co.uk before committing.
- **Porkbun** — about $11/year flat, free WHOIS privacy, sells .co.uk.
- **Avoid GoDaddy.** Cheap year one, then roughly double, and they charge
  extra for WHOIS privacy that everyone else includes.

**Which name.** A `.co.uk` reads as a UK business, which suits a
procurement buyer. A `.com` travels better. Buy both if the good one is
available — it is £18 a year to stop someone else taking your brand.

**Always take the free WHOIS privacy.** Without it your name, home
address and phone number are publicly searchable.

---

## Step 2 · Point the domain at GitHub Pages (15 minutes)

1. In your GitHub repository: **Settings → Pages → Custom domain**. Enter
   your domain and Save.
2. GitHub shows you the DNS records it needs. At your registrar, add:
   - Four **A records** for the apex domain pointing at GitHub's IPs
     (185.199.108.153, .109.153, .110.153, .111.153)
   - One **CNAME** for `www` pointing at `YOURNAME.github.io`
3. Back in GitHub, tick **Enforce HTTPS**. It may take an hour before
   that option becomes available — the certificate has to issue first.

Your site is then live at your own domain, still free.

> **One thing to change afterwards.** In Supabase → Edge Functions →
> Secrets, update `ALLOWED_ORIGIN` to your new domain
> (`https://contractiqplatform.co.uk`, no path, no trailing slash). Until you do,
> every AI call from the new domain fails with a 403.

---

## Step 3 · Email (20 minutes, free)

Your legal pages promise `legal@` and `privacy@` addresses. Those need to
actually receive mail.

**The free way — Cloudflare Email Routing.**
Works whether or not you bought the domain from Cloudflare; you just need
Cloudflare managing the DNS.

1. Add your domain to Cloudflare (free plan) and point the nameservers
   there.
2. **Email → Email Routing → Enable.** Cloudflare adds the MX records
   itself.
3. Create addresses forwarding to your normal inbox:
   `legal@`, `privacy@`, `hello@`, `support@`.
4. Verify the destination address when Cloudflare emails you.

This gives you **receiving** for nothing. To *send* from those addresses,
add them in Gmail under Settings → Accounts → "Send mail as".

**If you would rather have a real mailbox**, Zoho Mail's free tier gives
you five users on one domain and sends properly from your domain. The
catch is it is webmail and mobile-app only — no Outlook or Apple Mail.

**Do not** put a Gmail address in the Terms of a B2B product. Procurement
teams notice.

---

## Step 4 · Stripe (when you are ready to charge)

Not yet. But when you are, here is the shape of it.

**Do not use the PHP files.** They need a PHP host. You already have
Supabase, and Stripe works fine from an Edge Function — the same "Deploy
a new function → Via Editor" flow you already know. No new hosting, no
new bill.

**What Stripe will need from you:**

- Company number 10885786 and the registered address
- A **business bank account in the name of Rita Baxi Limited** — not a
  personal account, and not Rita's personal account either
- ID for the person controlling the account
- Your live website URL with visible terms, pricing and contact details
  (they check)

**What it costs:** 1.5% + 20p on UK cards. On a £79 subscription that is
about £1.39, which barely moves your margin.

**The piece that is missing.** Even with payments working, the app has no
mechanism to give a customer the plan they bought — `EDITION` is compiled
into the build. That needs the plan reading from the database at runtime.
It is maybe half a day's work and I have not built it, because I do not
think it is what is blocking you.

---

## Step 5 · Before the first paying customer

In rough order of importance:

- [ ] Director appointment or written authority from Rita
- [ ] ICO registration (£52) and the number added to the Privacy Policy
- [ ] A solicitor reads the Terms, Privacy Policy and DPA
- [ ] Professional indemnity insurance
- [ ] Registered office service, if you would rather not publish home
- [ ] SIC code 62012 added
- [ ] Your own SMTP configured in Supabase, so verification emails are
      not rate-limited
- [ ] Business bank account for Stripe

The first four are the ones that would actually hurt to skip.

---

## What the legal pages now say

Filled in across `terms.html`, `privacy.html` and `dpa.html`:

- **Rita Baxi Limited**, company number **10885786**
- Registered office **103 Battalion Drive, Wootton, Northampton, NN4 6RX**
- Trading as **ContractIQ**
- `legal@contractiqplatform.co.uk` and `privacy@contractiqplatform.co.uk`
- A red placeholder marking the ICO number as outstanding

**If you buy a different domain**, re-run the script rather than editing
three files by hand:

```bash
python3 set_legal_details.py yourdomain.co.uk
```

That keeps all three documents consistent, which matters — a DPA that
cites a different contact address from the Privacy Policy is the sort of
inconsistency that undermines the whole set.
