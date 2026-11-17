#!/bin/bash
# Prathipan Holdings HQ · health check. Run on the VPS:  bash /opt/prathipan-hq/deploy/check.sh
HOST=hq.prathipanholdings.cloud
CFG=/var/www/hq/config.js
ok(){ printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
bad(){ printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAILS=$((FAILS+1)); }
FAILS=0
echo "HQ health check · $(date)"

# 1 files
for f in index.html hq.js favicon.svg config.js; do [ -s /var/www/hq/$f ] && ok "file $f present" || bad "file $f missing in /var/www/hq"; done

# 2 config
URL=$(grep -o 'supabaseUrl: *"[^"]*"' $CFG 2>/dev/null | cut -d'"' -f2)
KEY=$(grep -o 'supabaseAnonKey: *"[^"]*"' $CFG 2>/dev/null | cut -d'"' -f2)
NAR=$(grep -o 'narrateUrl: *"[^"]*"' $CFG 2>/dev/null | cut -d'"' -f2)
case "$URL" in https://*.supabase.co) ok "config supabaseUrl = $URL";; *) bad "config supabaseUrl not set";; esac
case "$KEY" in sb_publishable_*|eyJ*) ok "config key looks right (${KEY:0:18}…)";; sb_secret_*) bad "config uses the SECRET key — replace with the publishable key";; *) bad "config supabaseAnonKey not set";; esac
[ -n "$NAR" ] && ok "narrateUrl set ($NAR)" || echo "  info  narrateUrl empty → CFO desk hidden (optional)"

# 3 nginx + tls
nginx -t >/dev/null 2>&1 && ok "nginx config valid" || bad "nginx config invalid (run: nginx -t)"
systemctl is-active --quiet nginx && ok "nginx running" || bad "nginx not running"
grep -q "ssl_certificate" /etc/nginx/sites-enabled/hq 2>/dev/null && ok "HTTPS configured for $HOST" || bad "no certificate in nginx site (run certbot)"
EXP=$(openssl x509 -enddate -noout -in /etc/letsencrypt/live/$HOST/fullchain.pem 2>/dev/null | cut -d= -f2); [ -n "$EXP" ] && ok "certificate expires $EXP" || bad "certificate file not found"
systemctl list-timers 2>/dev/null | grep -q certbot && ok "certificate auto-renew timer on" || echo "  info  certbot timer not listed (cron may handle it)"

# 4 dns + public reachability
IP=$(getent hosts $HOST | awk '{print $1}' | head -1); MY=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')
[ -n "$IP" ] && ok "DNS $HOST → $IP" || bad "DNS: $HOST does not resolve yet"
[ "$IP" = "$MY" ] && ok "DNS points at this server ($MY)" || echo "  info  this server's IP is $MY (DNS says $IP)"
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" https://$HOST/); [ "$CODE" = 200 ] && ok "https://$HOST/ answers 200" || bad "https://$HOST/ answers $CODE"
curl -s -m 10 https://$HOST/ | grep -q "Sign in to HQ" && ok "page contains the sign-in screen" || bad "page is not the HQ app"
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" http://$HOST/); case $CODE in 301|302|308) ok "http → https redirect ($CODE)";; *) bad "http does not redirect (got $CODE)";; esac
curl -s -m 10 -I https://$HOST/ | grep -qi "x-frame-options" && ok "security headers present" || echo "  info  security headers missing (cosmetic)"

# 5 supabase
if [ -n "$URL" ] && [ -n "$KEY" ]; then
  CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$URL/auth/v1/health" -H "apikey: $KEY"); [ "$CODE" = 200 ] && ok "Supabase auth reachable" || bad "Supabase auth health returned $CODE"
  R=$(curl -s -m 10 -X POST "$URL/rest/v1/rpc/hq_is_member" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}' -w " HTTP%{http_code}")
  case "$R" in *HTTP200*) ok "schema installed (hq_is_member responds)";; *HTTP401*|*HTTP403*) bad "key rejected by Supabase ($R)";; *) bad "schema not found or API error ($R) — run schema.sql";; esac
  R=$(curl -s -m 10 "$URL/rest/v1/docs?select=id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -w " HTTP%{http_code}")
  case "$R" in "[] HTTP200") ok "docs table exists; locked to members (anonymous sees 0 rows — correct)";; *HTTP200*) echo "  warn  docs readable anonymously — RLS not applied?";; *) bad "docs table check failed ($R)";; esac
  S=$(curl -s -m 10 "$URL/auth/v1/settings" -H "apikey: $KEY"); echo "$S" | grep -q '"email":true' && ok "email sign-in enabled" || bad "email sign-in disabled in Supabase Auth"
  echo "$S" | grep -q '"disable_signup":false' && ok "sign-up open (people can create accounts)" || echo "  warn  sign-up disabled — invited people cannot register"
  [ -n "$NAR" ] && { CODE=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -X POST "$NAR" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}'); case $CODE in 401) ok "narrate function deployed (asks for sign-in — correct)";; *) bad "narrate function returned $CODE";; esac; }
fi

echo; [ $FAILS = 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS check(s) failed — send this output to Claude"
