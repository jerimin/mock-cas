# mock-cas

Timed multiple-choice mock exam for the H3C CAS Cloud Automation System certification syllabus, deployed at https://mock.mymine.space.

Vanilla HTML + CSS + JS, served from Cloudflare Workers Static Assets. No build step. No framework.

## Layout

```
public/                   # everything served by Workers Static Assets
  index.html              # landing
  exam.html               # exam runner (setup, running, review states)
  404.html
  _headers                # CSP + cache headers
  assets/
    css/site.css
    js/exam.js            # state machine, timer, scoring
    data/bank.json        # 60 questions (10 per module)
    img/favicon.svg
src/index.ts              # Worker entry — proxies everything to ASSETS
wrangler.jsonc            # Workers config
build/                    # gitignored — pdf text + per-section JSON used to assemble bank.json
```

## Local dev

```sh
npm install
npm run dev
```

`npm run dev` runs Wrangler in local Workers Static Assets mode at http://localhost:8787.

## Deploy

Deploys land automatically via the Cloudflare Workers Builds GitHub App on push to `main`. No manual `wrangler deploy` needed.

Custom domain `mock.mymine.space` is set in the Worker's *Domains & Routes* tab; DNS is managed in the `mymine.space` zone (proxied CNAME → Workers).

## Question bank

`public/assets/data/bank.json` is the only file the exam runner reads. It's a flat array of 60 objects:

```json
{
  "id": "intro-01",
  "section": "Virtualization Introduction",
  "question": "...",
  "options": ["A", "B", "C", "D"],
  "correctIndex": 0,
  "explanation": "..."
}
```

The exam runner shuffles question order and option order per attempt — `correctIndex` is the *original* index, the engine remaps it when rendering.

### Regenerating from PDFs

The 6 source PDFs live outside the repo (study material on the maintainer's machine). To regenerate `bank.json`:

1. `pdftotext -layout <pdf> build/pdf-text/NN-name.txt` for each module.
2. Write/regen `build/questions/NN-name.json` per module (10 questions each).
3. Merge into `public/assets/data/bank.json` (any JSON concat — `jq -s 'add' build/questions/*.json > public/assets/data/bank.json` works on a Bash host).

## Pass mark

70%. Shown in the review screen as Pass / Below pass mark.

## What's intentionally not here

- No backend, no accounts, no per-user history. Progress is in `localStorage` only.
- No analytics. No third-party scripts.
- No service worker / offline cache. CDN cache + the small bundle is enough.
