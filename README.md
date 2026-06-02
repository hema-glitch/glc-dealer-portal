# GLC Paints — Dealer Portal

## Deploy to Vercel (5 minutes)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "GLC Dealer Portal"
git remote add origin https://github.com/YOUR_USERNAME/glc-dealer-portal.git
git push -u origin main
```

### Step 2 — Deploy on Vercel
1. Go to https://vercel.com → Sign in with GitHub
2. Click **Add New Project**
3. Import your `glc-dealer-portal` repository
4. Click **Deploy** (framework = Other, no build command needed)

### Step 3 — Add Environment Variables
In Vercel → Your Project → Settings → Environment Variables, add ALL from `.env.example`:

| Variable | Value |
|---|---|
| ZOHO_CLIENT_ID | from api-console.zoho.com |
| ZOHO_CLIENT_SECRET | from api-console.zoho.com |
| ZOHO_REFRESH_TOKEN | from OAuth setup |
| ZOHO_ORG_ID | from Zoho Books Settings |
| ZOHO_ACCOUNTS_URL | https://accounts.zoho.com |
| ZOHO_BOOKS_URL | https://www.zohoapis.com/books/v3 |
| ZOHO_INVENTORY_URL | https://www.zohoapis.com/inventory/v1 |
| APP_URL | https://your-app.vercel.app (set after first deploy) |
| JWT_SECRET | any long random string |
| ADMIN_EMAIL | admin@glcpaints.com |
| ADMIN_PASSWORD | your admin password |

### Step 4 — Update Zoho OAuth Redirect URI
In https://api-console.zoho.com → Your App → Edit:
Add `https://your-app.vercel.app/zoho/callback` to Authorized Redirect URIs

### Step 5 — Redeploy
After adding env vars, go to Vercel → Deployments → Redeploy

## Local Development
```bash
npm install
cp .env.example .env
# Fill in your credentials in .env
npm run dev
```
