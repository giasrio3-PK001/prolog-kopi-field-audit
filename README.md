# Prolog Kopi — Field Audit Control

Mobile-first operational control web app for Prolog Kopi. It uses the Supabase master data (`outlets`, `crews`, `sops`, `indicators`) plus realtime `audits` and `coaching_actions`.

## What is included

- Dashboard operational control center.
- KPI for audit volume, average score, high risk, open actions, outlet coverage, and master SOP readiness.
- SOP Control page for all 32 SOP and indicator detail.
- Audit Lapangan flow with dependent Outlet → Crew, SOP → Indicator, 1–5 score, auto diagnosis/risk/coaching, photo evidence, and offline queue.
- Coaching Action flow with PIC, due date, status, SLA and follow-up.
- Realtime subscriptions for audits and coaching actions.
- Local/offline fallback using browser storage when Supabase is not configured.

## Supabase

Use the schema already created in your Supabase project. The app expects these tables:

- `outlets`
- `crews`
- `sops`
- `indicators`
- `audits`
- `coaching_actions`

The app also reads `public.sop_progress` when it exists. If the view is unavailable, it calculates master readiness locally from `sops.indicator_count` and `indicators`.

## Configure

Edit `config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLISHABLE_OR_ANON_KEY",
  FORCE_LOCAL: false
};
```

Do not put a Supabase service-role key in the browser.

## Local test

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Vercel

Deploy the folder as a static site. `vercel.json` is already included. For the simplest setup, commit the folder to GitHub, import the repository into Vercel, and deploy. You can either configure the public Supabase URL/key inside `config.js` or use the existing config-generation script.

## Notes

The dashboard distinguishes **Audit Performance** from **Master SOP Readiness**. Master readiness is about how many indicator rows are populated against the SOP target; audit performance is driven by the actual field audit records and scores.

For production use with multiple teams, add authentication and tighten RLS policies before opening the app to the field.
