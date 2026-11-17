# Prathipan Holdings HQ — hq.prathipanholdings.cloud

The ERP as a standalone web app: your own database (Supabase), sign-in, roles, live updates, and the CFO desk narrated by Claude through a server-side function. Nothing in it depends on claude.ai once it's live.

```
site/       → upload this folder to the web host (index.html, hq.js, config.js, favicon, headers)
supabase/   → schema.sql (tables + security), seed.sql (your 129 records), functions/narrate (Claude proxy)
```

Total setup is about 30 minutes. Steps 1–4 are once; 5 is per person you invite.

---

## 1. Database (Supabase, free tier is enough)

1. Go to supabase.com → **New project**. Name `prathipan-hq`, region **Mumbai (ap-south-1)**, set a strong database password (you won't need it in the app).
2. Left menu **SQL Editor → New query**. Paste all of `supabase/schema.sql` → **Run**. (Creates tables, row-level security, the owner rule, realtime.)
3. New query again. Paste all of `supabase/seed.sql` → **Run**. (Loads your 20 companies, 55 brands, compliance items, legal notices, allocations, investments, shareholders, intercompany, ventures and group settings exactly as they are in the Claude version today.)
4. **Authentication → Providers → Email**: keep it enabled. If you want people to sign in immediately without clicking a confirmation email, switch off *Confirm email*.
5. **Authentication → URL Configuration**: Site URL `https://hq.prathipanholdings.cloud`, and add the same to *Redirect URLs*.
6. **Project Settings → API**: copy **Project URL** and the **anon public** key.

Open `site/config.js` and fill in:

```js
window.HQ_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
  narrateUrl: ""   // filled in step 3
};
```

The anon key is meant for browsers; the data is protected by the row-level security in `schema.sql`, not by hiding the key.

**Owner:** `schema.sql` names `prathipanshanmugham33@gmail.com` as the owner (always Admin, cannot be locked out). To change it later: SQL Editor → `update hq_config set value = 'new@email' where key = 'owner_email';`

## 2. Put the site online

Any static host works. Two one-drag options:

**Netlify (simplest):** app.netlify.com → *Add new site → Deploy manually* → drag the whole `site` folder. You get `something.netlify.app` immediately. Then *Domain management → Add a domain → `hq.prathipanholdings.cloud`*; Netlify issues the SSL certificate once DNS points at it.

**Cloudflare Pages:** dash.cloudflare.com → *Workers & Pages → Create → Pages → Upload assets* → drag `site`. Then *Custom domains → Set up a custom domain*.

To update the app later, drag the folder again. Data lives in Supabase, so redeploys never touch it.

## 3. DNS at your registrar

Add one record where `prathipanholdings.cloud` is managed:

| Type  | Name / host | Value                                   | TTL  |
|-------|-------------|-----------------------------------------|------|
| CNAME | `hq`        | `<your-site>.netlify.app` (or `<project>.pages.dev` for Cloudflare) | Auto / 3600 |

Delete any existing A/CNAME record for `hq` first. Propagation is usually minutes, up to a few hours. HTTPS is automatic on both hosts after the record resolves.

## 4. CFO desk and report narration (Claude)

The browser never sees your Anthropic key. A Supabase Edge Function holds it and only answers signed-in members.

*Via the dashboard:* **Edge Functions → Deploy a new function → Via Editor**, name it `narrate`, paste `supabase/functions/narrate/index.ts`, Deploy. Then **Edge Functions → Secrets** (or Project Settings → Edge Functions): add `ANTHROPIC_API_KEY` = your key from console.anthropic.com. Optional secrets: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `MAX_TOKENS` (default 1200).

*Via CLI:*
```
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy narrate
```

Then set `narrateUrl: "https://xxxxxxxx.supabase.co/functions/v1/narrate"` in `config.js` and re-upload. Leave it empty and the Ask-the-CFO panel simply stays hidden.

## 5. First sign-in and inviting people

1. Open `https://hq.prathipanholdings.cloud` → *First time here? Create your account* with the owner email. You land in the ERP as Admin.
2. **Users & roles → Add a person** → type their email → pick *invite by email* → choose Admin / Manager / Staff and the companies. They open the site, create their account with that email, and the role is attached automatically.
3. Roles: **Admin** everything except owner-only settings · **Manager** their companies: books, budgets, brands, KPIs, requests · **Staff** brand results, compliance status, legal updates for their companies. The database itself only lets members read or write; everyone else sees a locked screen.

Sign-in options on the login screen: password, emailed magic link, password reset.

## What is where

| Thing | Where it lives |
|---|---|
| All ERP data | Supabase table `docs` (one row per record, JSON), realtime on |
| Who has access | tables `members` (roles) and `profiles` (names) |
| Activity log | `docs` rows in collection `activity` |
| Anthropic key | Supabase function secret only |
| App code | `site/index.html` + `site/hq.js`; static, no build step |

## Keeping the two versions

The Claude artifact copy keeps working on its own; `seed.sql` is a snapshot taken today. From the day HQ goes live, enter data in HQ. If you want a fresh snapshot later, ask Claude to export again and re-run the new seed (it overwrites matching records, keeps the rest).
