# Setup

## 1. Create GCP project + deploy backend

```sh
# from C:/Users/zelid/jb-printful-creator/backend

# one-time GCP setup
gcloud projects create jb-printful --name="JB Printful"
gcloud config set project jb-printful
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud auth login

# deploy
gcloud run deploy jb-printful-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "PRINTFUL_TOKEN=FluY9TemGwmWyJ8nFPssDHNRx66injd7UXg3ba5l,STORE_ID=18227887,APP_PASSWORD=CHANGE_ME,ALLOWED_ORIGIN=https://zelidav.github.io"
```

After deploy, gcloud prints a service URL like `https://jb-printful-api-abc123-uc.a.run.app`. Save it — you'll paste it into the frontend login.

## 2. Create GitHub repo + push

```sh
# from C:/Users/zelid/jb-printful-creator
gh repo create jb-printful-creator --public --source=. --remote=origin --push
```

## 3. Enable GitHub Pages

```sh
gh repo edit --enable-issues=false
# in repo settings → Pages → Source: GitHub Actions
```

After the first push to `main`, the workflow deploys frontend to `https://zelidav.github.io/jb-printful-creator/`.

## 4. Sign in

Open the GH Pages URL, paste:
- Backend URL: the Cloud Run URL from step 1
- Password: the `APP_PASSWORD` you set

## Updating

- Frontend: push to `main`, auto-deploys via GH Actions
- Backend: `cd backend && npm run deploy`

## Local dev

```sh
# backend
cd backend
cp .env.example .env  # fill in values
npm install
npm run dev

# frontend (any static server)
cd ../frontend
python -m http.server 5173
# open http://localhost:5173 — backend URL = http://localhost:8080
```

## Cost

Cloud Run free tier (2M requests, 360k vCPU-sec/mo) covers typical use. Cold start ~2s. GH Pages is free.
