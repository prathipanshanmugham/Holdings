#!/bin/bash
# Prathipan Holdings HQ · health and security check. Run on the VPS:  bash /opt/prathipan-hq/deploy/check.sh
HOST=hq.prathipanholdings.cloud
MCPHOST=mcp.prathipanholdings.cloud
CFG=/var/www/hq/config.js
ok(){ printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
bad(){ printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAILS=$((FAILS+1)); }
info(){ printf "  info  %s\n" "$1"; }
FAILS=0
echo "HQ check · $(date)"

echo "— Files"
for f in index.html hq.js favicon.svg config.js vendor/supabase.min.js; do [ -s /var/www/hq/$f ] && ok "$f present" || bad "$f missing in /var/www/hq"; done
URL=$(grep -o 'supabaseUrl: *"[^"]*"' $CFG 2>/dev/null | cut -d'"' -f2)
KEY=$(grep -o 'supabaseAnonKey: *"[^"]*"' $CFG 2>/dev/null | cut -d'"' -f2)
case "$URL" in https://*.supabase.co) ok "supabaseUrl set";; *) bad "supabaseUrl not set in config.js";; esac
case "$KEY" in sb_publishable_*|eyJ*) ok "browser key is the publishable key";; sb_secret_*) bad "config.js holds the SECRET key — replace it with the publishable key now";; *) bad "supabaseAnonKey not set";; esac

echo "— Web server"
nginx -t >/dev/null 2>&1 && ok "nginx config valid" || bad "nginx config invalid (nginx -t)"
systemctl is-active --quiet nginx && ok "nginx running" || bad "nginx not running"
EXP=$(openssl x509 -enddate -noout -in /etc/letsencrypt/live/$HOST/fullchain.pem 2>/dev/null | cut -d= -f2); [ -n "$EXP" ] && ok "certificate valid until $EXP" || bad "certificate missing"
systemctl list-timers 2>/dev/null | grep -q certbot && ok "certificate auto-renewal scheduled" || info "certbot timer not listed (cron may handle renewal)"
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" https://$HOST/); [ "$CODE" = 200 ] && ok "https://$HOST answers" || bad "https://$HOST answers $CODE"
curl -s -m 10 https://$HOST/ | grep -q "Sign in to HQ" && ok "sign-in screen served" || bad "page is not the HQ app"
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" http://$HOST/); case $CODE in 301|308) ok "http redirects to https";; *) bad "http does not redirect ($CODE)";; esac
H=$(curl -s -m 10 -I https://$HOST/)
echo "$H" | grep -qi "content-security-policy: default-src 'none'" && ok "Content-Security-Policy active" || bad "CSP header missing (run deploy/harden.sh)"
echo "$H" | grep -qi "strict-transport-security" && ok "HSTS active" || bad "HSTS missing (run deploy/harden.sh)"
echo "$H" | grep -qi "x-frame-options: deny" && ok "clickjacking blocked" || bad "X-Frame-Options missing"
echo "$H" | grep -qiE "^server: nginx/[0-9]" && bad "nginx version visible (run deploy/harden.sh)" || ok "server version hidden"
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" https://$HOST/.git/config); [ "$CODE" = 404 ] && ok "hidden files not served" || bad "/.git answered $CODE"

echo "— Database (Supabase)"
if [ -n "$URL" ] && [ -n "$KEY" ]; then
  CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$URL/auth/v1/health" -H "apikey: $KEY"); [ "$CODE" = 200 ] && ok "Supabase reachable" || bad "Supabase health $CODE"
  R=$(curl -s -m 10 -X POST "$URL/rest/v1/rpc/hq_read" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"p_collection":"companies"}' -w " HTTP%{http_code}")
  case "$R" in *PGRST202*|*HTTP404*) bad "security.sql not applied yet (run it in Supabase → SQL Editor)";; *HTTP401*|*HTTP403*|*42501*) ok "security rules installed; anonymous visitors get nothing";; *HTTP200*) case "$R" in "[] HTTP200") ok "security rules installed; anonymous visitors get nothing";; *) bad "anonymous visitors can read data!";; esac;; *) bad "unexpected answer: $R";; esac
  R=$(curl -s -m 10 "$URL/rest/v1/docs?select=id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -w " HTTP%{http_code}")
  case "$R" in "[] HTTP200"|*HTTP401*|*HTTP403*|*42501*) ok "ledger table closed to anonymous visitors";; *) bad "ledger table answered anonymously: ${R:0:80}";; esac
  S=$(curl -s -m 10 "$URL/auth/v1/settings" -H "apikey: $KEY")
  echo "$S" | grep -q '"email":true' && ok "email sign-in enabled" || bad "email sign-in disabled"
  echo "$S" | grep -q '"mailer_autoconfirm":false' && ok "email confirmation required" || bad "turn ON 'Confirm email' in Supabase → Authentication → Sign In / Providers → Email"
  echo "$S" | grep -q '"disable_signup":false' && ok "sign-up open for invited people" || info "sign-up disabled — invited people can't register"
fi

echo "— Connector"
if systemctl list-unit-files hq-mcp.service >/dev/null 2>&1 && [ -f /etc/hq-mcp.env ]; then
  systemctl is-active --quiet hq-mcp && ok "connector running" || bad "connector stopped (journalctl -u hq-mcp -n 30)"
  [ "$(systemctl show -p User --value hq-mcp)" = "hq-mcp" ] && ok "runs as its own unprivileged user" || bad "connector not sandboxed (run deploy/harden.sh)"
  [ "$(stat -c %a /etc/hq-mcp.env)" = 600 ] && ok "secrets file readable by root only" || bad "chmod 600 /etc/hq-mcp.env"
  T=$(grep '^HQ_MCP_TOKEN=' /etc/hq-mcp.env | cut -d= -f2); [ ${#T} -ge 32 ] && ok "access token is long enough" || bad "access token too short"
  grep -q '^SUPABASE_KEY=sb_secret' /etc/hq-mcp.env && bad "connector uses a SECRET key — use the publishable key" || ok "connector uses the publishable key"
  [ "$(curl -s -m 10 https://$MCPHOST/health)" = '{"ok":true}' ] && ok "https://$MCPHOST healthy" || bad "connector not reachable over https"
  CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST https://$MCPHOST/mcp -H "Content-Type: application/json" -d '{}'); [ "$CODE" = 401 ] && ok "connector refuses requests without the token" || bad "connector answered $CODE without a token"
  grep -q "$T" /var/log/nginx/*.log 2>/dev/null && bad "token appears in nginx logs — run deploy/harden.sh, then: truncate -s0 /var/log/nginx/*.log" || ok "token not in web logs"
  grep -q '^HQ_MCP_WRITES=off' /etc/hq-mcp.env && info "connector is read-only" || info "connector can write (every write is in the audit trail)"
else info "connector not installed"; fi

echo "— Server"
systemctl is-active --quiet fail2ban && ok "fail2ban active" || bad "fail2ban not running (run deploy/harden.sh)"
grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades && ok "automatic security updates on" || bad "automatic updates off (run deploy/harden.sh)"
[ -f /var/run/reboot-required ] && info "a reboot is pending to finish security updates (reboot when convenient)"
EXTRA=$(ss -tlnH | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | grep -vxE '22|80|443' | tr '\n' ' ')
[ -z "$EXTRA" ] && ok "only 22, 80, 443 public" || info "other public ports: $EXTRA(close unused ones in hPanel → VPS → Firewall)"

echo; [ $FAILS = 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS check(s) failed — send this output to Claude"
