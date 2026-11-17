# Prathipan Holdings HQ — hq.prathipanholdings.cloud

The group ERP as a standalone web app on your own VPS, with its data in Supabase, two-step sign-in, database-enforced roles, a tamper-proof audit trail, and an MCP connector for Claude and n8n.

```
site/       the web app nginx serves (/var/www/hq → /opt/prathipan-hq/site); config.js lives only on the server
supabase/   schema.sql (tables) · security.sql (rules) · seed.sql (data snapshot) · functions/narrate (Claude proxy)
mcp/        the connector (Node service behind nginx at mcp.prathipanholdings.cloud)
deploy/     harden.sh · update.sh · check.sh · rotate-secrets.sh · nginx site · security headers
```

## Everyday commands (VPS, as root)

| What | Command |
|---|---|
| Update to the latest version | `bash /opt/prathipan-hq/deploy/update.sh` |
| Check health and security | `bash /opt/prathipan-hq/deploy/check.sh` |
| Re-apply server hardening | `bash /opt/prathipan-hq/deploy/harden.sh` |
| New connector token + agent password | `bash /opt/prathipan-hq/deploy/rotate-secrets.sh` |
| Connector logs | `journalctl -u hq-mcp -f` |

## How access works

- **Owner** (`owner_email` in `hq_config`): everything, and the only person who can grant or remove access.
- **Admin**: all companies and modules, except granting access.
- **Manager**: only their companies. Records books, balances, spending, KPI actuals; manages brands, compliance and legal notices; raises capital requests. Cannot change stake, targets, CEO, budgets, settings or treasury, and cannot approve money.
- **Staff**: only their companies' brands, compliance and legal notices. Sees company names only (no financials). Can record brand months, mark compliance filed and add legal updates.

These rules are enforced **inside the database** (`security.sql`), not only on screen: even someone with the page's key and developer tools gets nothing beyond their role. Only confirmed email addresses count, so nobody can claim an invited email they don't own.

**Two-step sign-in** is required for the Owner and Admins (Google or Microsoft Authenticator). Anyone who enrols is always asked for a code. The connector's agent account is exempt (it has no phone); its secrets are root-only on the server.

Every change is written to `audit_log` (who, when, before, after). Nobody can edit or delete it through the app or API. The owner can read it in Supabase → SQL Editor:

```sql
select at, actor_email, action, collection, doc_id from public.audit_log order by at desc limit 100;
```

Sessions sign out after 60 minutes without activity (`idleMinutes` in `config.js`).

## Fresh install (for reference)

1. Supabase project (Mumbai). SQL Editor: run `schema.sql`, then `security.sql`, then `seed.sql`.
2. Authentication → Sign In / Providers → Email: **Confirm email ON**, minimum password length **10**. URL Configuration: Site URL and Redirect URL `https://hq.prathipanholdings.cloud` only.
3. VPS: `git clone https://github.com/prathipanshanmugham/Holdings.git /opt/prathipan-hq`, `ln -sfn /opt/prathipan-hq/site /var/www/hq`, copy `site/config.example.js` to `site/config.js` and fill in the Project URL and **publishable** key (never the secret key).
4. DNS `A hq → VPS IP`, `certbot --nginx -d hq.prathipanholdings.cloud`, then `bash deploy/harden.sh`.
5. Open the site → create the owner account → set up the authenticator.

## Connector (MCP)

17 tools: group snapshot, companies, company metrics, CEO scorecards, brand performance, legal notices, compliance calendar, capital & holdings, alerts, activity log, plus writes (record month, update company, set budget, log/update legal notice, set compliance status, capital allocation). Writes need exact company names, validate every value against the ERP's own vocabulary, and land in the activity log and audit trail. Set `HQ_MCP_WRITES=off` in `/etc/hq-mcp.env` for a read-only connector; give the agent a Manager role to limit it to certain companies.

Install once: `bash /opt/prathipan-hq/mcp/install.sh` and follow its printout. Connect in claude.ai → Settings → Connectors with `https://mcp.prathipanholdings.cloud/<token>/mcp`. Treat that URL like a password.

## CFO desk (optional)

Supabase → Edge Functions → deploy `supabase/functions/narrate/index.ts` as `narrate`; add secret `ANTHROPIC_API_KEY`. Then set `narrateUrl` in `config.js`. It only answers signed-in members, only from the HQ site.

## If something goes wrong

- **Lost the phone with the authenticator:** SQL Editor → `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'YOUR@EMAIL');` then sign in and set it up again.
- **Emergency: switch off required two-step sign-in:** `update public.hq_config set value = '' where key = 'mfa_required_roles';` (turn back on with `'Owner,Admin'`).
- **Change the owner:** `update public.hq_config set value = 'new@email' where key = 'owner_email';`
- **Site down after a server change:** `harden.sh` keeps a copy of the previous nginx config in `/root/hq-backup-<time>/` and restores it automatically if its test fails.
