# codeiqholdings-website

The CodeIQ Holdings Ltd website. Private repository, deployed to IONOS webspace
by GitHub Actions on every push to `main`.

CodeIQ Holdings Ltd · Registered in England and Wales, company no. 17454743
103 Battalion Drive, Northampton NN4 6RX · info@codeiqholdings.co.uk

---

## What is here

```
index.html                     the one-page site
legal.html                     the Legal Centre (17 documents)
404.html                       not-found page
robots.txt                     crawl rules, including AI answer engines
sitemap.xml                    sitemap
llms.txt                       plain-text summary written for AI assistants
site.webmanifest               icons and theme colours
.htaccess                      HTTPS + www, security headers, caching, 404
assets/                        logo files, favicons, social card
assets/screenshots/            ContractIQ screenshots (see README there)
.github/workflows/deploy.yml   deploys to IONOS on push to main
```

Both pages are self-contained: all CSS and JavaScript are inline. The only
external request is the Google Fonts stylesheet; everything else, including the
ContractIQ screenshots, is served from this folder. There is no build step, no
package manager and no dependencies to keep patched. Editing a page means
editing one file.

---

## Why the repository is private and the site is still public

GitHub Pages only serves from a **public** repository on the GitHub Free plan.
Publishing Pages from a private repository requires GitHub Pro.

This setup avoids that entirely. The repository stays private on the Free plan,
and GitHub Actions copies the finished files to the IONOS webspace you are
already paying for. GitHub never hosts anything. The source is never public.

GitHub Free includes 2,000 Actions minutes per month for private repositories.
This workflow takes roughly one minute per deploy, so a few dozen deploys a
month uses a small fraction of the allowance.

---

## First-time setup

1. Create a **private** repository on GitHub and push this folder to `main`.

2. Generate a deploy key on your own machine:

   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/codeiq_deploy
   ```

   This produces `codeiq_deploy` (private) and `codeiq_deploy.pub` (public).

3. In the IONOS control panel, go to **Hosting → SFTP & SSH** and add the
   contents of `codeiq_deploy.pub` as an authorised key. Note the server
   address (it looks like `access123456789.webspace-data.io`) and the username.

4. In GitHub, go to **Settings → Secrets and variables → Actions** and add four
   repository secrets:

   | Secret | Value |
   |---|---|
   | `IONOS_HOST` | `access123456789.webspace-data.io` |
   | `IONOS_USER` | your SFTP username |
   | `IONOS_SSH_KEY` | the whole contents of `codeiq_deploy`, including the BEGIN and END lines |
   | `IONOS_TARGET_DIR` | the document root, e.g. `/` or `/codeiqholdings.co.uk` |

   Check the document root in the IONOS panel before the first deploy. Pointing
   it at the wrong folder is the one mistake that wastes an afternoon.

5. Push to `main`, or run the workflow manually from the **Actions** tab. Watch
   the run; the last step reports the HTTP status of the live pages.

---

## Making a change

```bash
git checkout -b update-the-contractiq-screenshots
# edit index.html, or replace files in assets/screenshots/
git commit -am "Refresh the ContractIQ screenshots"
git push -u origin update-the-contractiq-screenshots
```

Open a pull request, or merge straight to `main` if you are working alone.
Merging to `main` deploys. There is no staging environment; if you want one,
add a second IONOS subdomain and a second workflow triggered on a `staging`
branch.

---

## Before the first real deploy

- [x] ICO registration reference inserted — ICO:00015500673
- [ ] Fill in the sub-processor table in `legal.html`: hosting, email, payment providers, Supabase region
- [ ] Confirm the VAT position in `legal.html`
- [x] Cookie consent banner implemented — blocks non-essential storage until consent
- [ ] Upload `assets/codeiq-icon-108.png` and point the email signature at it
- [x] Four ContractIQ screenshots added to `assets/screenshots/`
- [ ] Add insurance details once you have them (search `ins-slot` in index.html)

Search for `tofill`, `to be inserted` and `To confirm` to find every one of
these. The deploy workflow warns if any are still present, but does not block.

---

## Security notes

- Never commit the private key, or anything else with a credential in it. The
  `.gitignore` covers the usual accidents but is not a substitute for looking.
- If the deploy key is ever exposed, remove it in the IONOS panel first, then
  rotate the GitHub secret. Revoking access at IONOS is what actually stops it.
- Keep the repository private even though the site is public. The repository
  history is the evidence of authorship for the IP assignment, and it should
  not be readable by anyone who asks.
