# Safepay

Lightning payment links with a Cash App deep link and QR code.

- `public/` checkout page and `/admin.html` link maker
- `api/index.js` serverless API (Postgres via `DATABASE_URL`)
- `lib/providers.js` manual mode (default), phoenixd adapter, Speed placeholder
- Copy `.env.example` for the variables to set in Vercel
