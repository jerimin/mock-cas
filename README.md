# mock-cas

[![v1.3.0](https://img.shields.io/badge/version-1.2.0-F38020.svg)](https://github.com/jerimin/mock-cas/releases/tag/v1.3.0)
[![Status: locked](https://img.shields.io/badge/status-locked-1F9C5B.svg)](#status)

Timed mock exam for **GB0-713 — Deploy and Manage the H3C CAS Virtualization Platform (H3CNE-Cloud)**. Live at https://mock.mymine.space.

Vanilla HTML + CSS + JS, served from Cloudflare Workers Static Assets with a tiny Worker for stats, visit tracking, and emailing the detailed report. No framework. No build step beyond `wrangler deploy`.

## Status

**Locked at v1.1.0** — feature-complete; merges to `main` should be limited to bank-content updates, CF deploy fixes, security patches, and additional tests. Major behaviour changes warrant a v2 branch.

Always run `npm run check` before pushing (it runs `tsc --noEmit && validate && test`). All five targeted-regression tests block:

- A 6-option question (the v1.0.0 bug where intro-06 escaped initial verification)
- An exact-stem duplicate (the deploy-27 vs deploy-12 bug)
- A format-vs-correctIndices mismatch (single with 2 indices, multi with 1)
- An out-of-range correctIndex
- Any reference to private source material ("the course", "the PDF", "the module", "the slide", "in the table", etc. — see `SOURCE_LEAK` regex in `schema.js`). Allowed false-positives: "the reference port" (LACP), "the reference architecture".

What's locked at v1.0.0:
- Bank: 250 questions (25/50/38/50/50/37 per module · 40/29/30 single/multi/negative · zero duplicates)
- Engine: 50Q/60min/60% pass policy, partial credit, end-anytime, stratified sampling, behaviour analysis (timing/marks/changes)
- Email flow: 6-digit verification → SMTP2GO HTML summary email + PDF attachment (pdf-lib, Worker-side)
- UI: CF-style light + dark themes, distinct nav-grid colours, fits a single viewport, 10s Cloud Digit sponsored toast on result
- Worker: `/api/stats`, `/api/track`, `/api/email-verify-init`, `/api/email-verify-confirm`
- KV: `mock-cas-stats` (id `0239f7fd…`) bound as `STATS_KV`

## Layout

```
public/                       # everything served by Workers Static Assets
  index.html                  # landing
  exam.html                   # exam runner (setup, running, review states)
  404.html
  _headers                    # CSP + cache headers
  assets/
    css/site.css              # CF-style theme with light + dark
    js/site.js                # theme toggle, live counters, anon tracking
    js/exam.js                # exam engine v3 (50Q/60min/60% policy, partial credit)
    data/bank.json            # 120-Q bank; 50 picked per attempt
    img/favicon.svg
src/index.ts                  # Worker — routes /api/* + delegates rest to ASSETS
wrangler.jsonc                # Workers config (KV binding, vars)
build/                        # gitignored — pdftotext + intermediate JSON
```

## Policy (locked to official H3C syllabus)

- **50** single-/multi-choice questions
- **60** minutes
- **600/1000** (60%) pass mark
- Single + multi format; multi-answer earns partial credit (correct picks − wrong picks) / total correct, floored at 0
- End-exam button submits any time

## Question bank

`public/assets/data/bank.json` — 120 questions, schema v2:

```json
{
  "id": "infra-01",
  "section": "Virtualized Infrastructure",
  "format": "single" | "multi" | "negative",
  "question": "...",
  "options": ["A...", "B...", "C...", "D..."],
  "correctIndices": [n, ...],
  "explanation": "..."
}
```

Bank composition (12/24/18/24/24/18) maps to the 6 study modules. Sampling weight (10/20/15/20/20/15) is applied per attempt — every attempt covers every module.

## Worker routes

| Route | Method | Purpose |
|---|---|---|
| `GET /api/stats` | public | Returns `{active, unique, total, ts}` — used by the live counters in the header |
| `POST /api/track` | public | Increments KV counters; called once per page load |
| `POST /api/email-report` | public | Accepts `{email, report}`; sends a styled HTML email via SMTP2GO |
| anything else | — | Delegated to `env.ASSETS.fetch(request)` |

## Required CF dashboard setup (one-time)

The repo is pre-wired but two things must be set in the Cloudflare dashboard:

1. **KV namespace** — already created (id `0239f7fd100a4699ab469f01c2526dcd`, title `mock-cas-stats`). `wrangler.jsonc` binds it as `STATS_KV`. No action needed unless the namespace is recreated.

2. **Secrets** — go to Worker `mock-cas` → **Settings → Variables and Secrets** and add the same `SMTP2GO_API_KEY` value the `clouddigit-site` Worker uses:

| Name | Type | Value |
|---|---|---|
| `SMTP2GO_API_KEY` | Secret | Same SMTP2GO API key used by `clouddigit-site`. Required for `/api/email-report`. |
| `SENDER_EMAIL` | Variable (optional) | Default `do-not-reply@mymine.space` (DKIM-verified for the `mymine.space` zone). |
| `SENDER_NAME` | Variable (optional) | Default `GB0-713 Mock Exam`. |

Naming matches `clouddigit-site` (`SMTP2GO_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME`) so the same SMTP2GO account is reused without changes. CF Worker secrets are write-only — you can't copy the value from `clouddigit-site` via the dashboard, so paste it once into mock-cas (or fetch it from the SMTP2GO admin → API Keys panel).

Without `SMTP2GO_API_KEY` the email endpoint returns 503 and the form shows an error — everything else still works.

## Live counters

`/api/stats` aggregates from KV:

- **active** — distinct visitor IDs seen in the last 5 minutes (rolling 1-min buckets, TTL 5 min)
- **unique** — distinct visitor IDs today (UTC, TTL 36h)
- **total** — incremented once per first-visit-today per visitor (lifetime cumulative)

Visitor ID = SHA-256 of `cf-connecting-ip + user-agent`, first 8 bytes hex. IPs are never stored.

## Local dev

```sh
npm install
npm run dev          # wrangler dev — serves http://localhost:8787 with KV miniflare
```

## Verify before pushing

```sh
npm run check        # tsc --noEmit, then bank validator, then vitest suite
# or individually:
npm run typecheck
npm run validate                 # bank-only schema + dup + balance check
npm run validate:strict          # same, but warnings fail too
npm test                         # 48 vitest cases — scoring, sampling, schema, live bank
```

CF Workers Build is configured at the dashboard; the simplest hardening is to set the **Build command** to `npm run check && npx wrangler deploy` so a bad bank or failing test blocks deploy.

### Shared lib (`public/assets/js/lib/`)

- `util.js`     — `shuffle`, `setsEqual`, `normaliseStem`
- `scoring.js`  — `scoreQuestion(selectedPositions, correctPositions)` returning `{score, status}`. Single source of truth for partial-credit math.
- `sampling.js` — `WEIGHTS`, `SECTIONS`, `computeTargets`, `stratifiedPick`
- `schema.js`   — `validateQuestion`, `validateBank`, `findDuplicateStems`, `findDuplicateIds`, `checkSectionBalance`, `checkFormatBalance`, `SEVERITY`, `VALID_FORMATS`

The browser engine (`exam.js`) is loaded as `type="module"` and imports from `./lib/*`. The same modules are imported by the Vitest tests and the `scripts/validate-bank.js` CLI — no duplication, no divergence.

## Deploy

Pushes to `main` deploy automatically via the Cloudflare Workers Builds GitHub App. No manual `wrangler deploy`.

## Themes

System default + explicit light/dark toggle in header. Preference stored as `mock-cas-theme` in localStorage. Inter font loaded from `rsms.me` (CSP-allowlisted).

## What's intentionally not here

- No user accounts. No per-user history. Email-report payload comes from the page; nothing about the user is stored on the server.
- No third-party analytics scripts. Counters are first-party via KV.
- No service worker / offline cache. Edge cache + the small bundle is enough.
