#!/bin/bash
# Prathipan Holdings HQ — server hardening. Run as root:  bash /opt/prathipan-hq/deploy/harden.sh
# Safe to run again. nginx changes are tested first and rolled back automatically if anything is wrong.
set -euo pipefail
R=/opt/prathipan-hq; TS=$(date +%Y%m%d-%H%M%S); BK=/root/hq-backup-$TS
step(){ printf "\n\033[1m%s\033[0m\n" "$1"; }
ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn(){ printf "  \033[33m!\033[0m %s\n" "$1"; }
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
mkdir -p "$BK"; chmod 700 "$BK"; cp -a /etc/nginx "$BK/nginx"
restore(){ warn "nginx test failed — restoring the previous configuration"; rm -rf /etc/nginx; cp -a "$BK/nginx" /etc/nginx; nginx -t && systemctl reload nginx; exit 1; }

step "1/6  Web server: rate limits, hidden version, security headers"
cp "$R/deploy/nginx-limits.conf" /etc/nginx/conf.d/hq-limits.conf
if ! grep -RqsE '^\s*server_tokens\s+off' /etc/nginx/nginx.conf /etc/nginx/sites-enabled/ /etc/nginx/conf.d/; then echo 'server_tokens off;' >> /etc/nginx/conf.d/hq-limits.conf; fi
for pair in "hq:$R/deploy/nginx-hq.conf" "mcp:$R/mcp/nginx-mcp.conf"; do
  name=${pair%%:*}; src=${pair#*:}; host="$name.prathipanholdings.cloud"
  if [ -f "/etc/letsencrypt/live/$host/fullchain.pem" ] && [ -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
    cp "$src" "/etc/nginx/sites-available/$name"; ln -sf "/etc/nginx/sites-available/$name" "/etc/nginx/sites-enabled/$name"; ok "$host secured"
  else warn "$host has no certificate yet — left unchanged"; fi
done
nginx -t 2>/dev/null || restore
systemctl reload nginx; ok "nginx reloaded (backup in $BK)"

step "2/6  Connector: dedicated user and sandbox"
if [ -f /etc/hq-mcp.env ]; then
  id hq-mcp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hq-mcp
  chown root:root /etc/hq-mcp.env; chmod 600 /etc/hq-mcp.env
  grep -q '^HQ_MCP_WRITES=' /etc/hq-mcp.env || echo 'HQ_MCP_WRITES=on' >> /etc/hq-mcp.env
  (cd "$R/mcp" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  sed "s#/usr/bin/node#$(command -v node)#" "$R/mcp/hq-mcp.service" > /etc/systemd/system/hq-mcp.service
  systemctl daemon-reload; systemctl enable hq-mcp >/dev/null 2>&1 || true; systemctl restart hq-mcp; sleep 3
  if systemctl is-active --quiet hq-mcp; then ok "connector running as hq-mcp in a sandbox"; else warn "connector did not start: journalctl -u hq-mcp -n 30"; fi
else warn "connector not installed yet — skipped"; fi

step "3/6  Brute-force protection (fail2ban)"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null
cat > /etc/fail2ban/jail.d/hq.local <<JAIL
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 169.254.0.0/16
bantime  = 1h
findtime = 10m
maxretry = 6
[sshd]
enabled = true
[nginx-limit-req]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
JAIL
systemctl enable --now fail2ban >/dev/null 2>&1; systemctl restart fail2ban; ok "fail2ban watching SSH and web rate limits"

step "4/6  Automatic security updates"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
ok "security patches install automatically"

step "5/6  File permissions"
[ -f "$R/site/config.js" ] && { chown root:root "$R/site/config.js"; chmod 644 "$R/site/config.js"; }
chown -R root:root "$R"; chmod -R go-w "$R"
ok "app files owned by root, not writable by services"

step "6/6  Open ports"
EXTRA=$(ss -tlnH | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | grep -vxE '22|80|443' || true)
if [ -n "$EXTRA" ]; then warn "Other public ports are open: $(echo $EXTRA | tr '\n' ' ')— close any you don't need in hPanel → VPS → Firewall"; else ok "only 22, 80 and 443 are public"; fi

printf "\n\033[1mDone.\033[0m Now run:  bash $R/deploy/check.sh\n"
