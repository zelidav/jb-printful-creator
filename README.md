# jb-printful-creator

Internal tool: select multiple Printful products, upload 1–3 patterns, batch-create them in your store. Auto-handles full-wrap items (canvas shoes, all-over tees) so seams match.

## Architecture

- **Frontend** (`frontend/`) — static SPA, deployed to GitHub Pages
- **Backend** (`backend/`) — Node + Express, deployed to Google Cloud Run. Holds the Printful token, runs the create jobs, handles wrap-matching with `sharp`.

```
browser ──HTTPS──▶ Cloud Run ──HTTPS──▶ Printful API
```

The Printful token lives in a Cloud Run env var; the browser only ever talks to the backend with a shared password.

## Local dev

```sh
# backend
cd backend
cp .env.example .env  # fill in PRINTFUL_TOKEN, APP_PASSWORD
npm install
npm run dev           # http://localhost:8080

# frontend
cd ../frontend
# edit BACKEND_URL in app.js to http://localhost:8080
python -m http.server 5173  # any static server
```

## Deploy

**Backend → Cloud Run** (one-time setup, then `npm run deploy`):
```sh
cd backend
gcloud config set project jb-printful
gcloud run deploy jb-printful-api \
  --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars PRINTFUL_TOKEN=...,APP_PASSWORD=...,STORE_ID=18227887,ALLOWED_ORIGIN=https://zelidav.github.io
```

**Frontend → GitHub Pages**: push to `main` and the workflow auto-deploys.

## Wrap-matching

When a selected catalog product has multiple panel placements (e.g. `outside_left_quarter`/`inside_left_quarter` on canvas shoes), the backend:
1. Pulls Printful's print template to get exact safe-area + seam coordinates
2. Composites the user's pattern across panels so the heel/side seams line up
3. For unknown wrap types, asks the frontend to prompt the user

See `backend/src/wrap.js`.
