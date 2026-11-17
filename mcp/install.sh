#!/bin/bash
# One-time install of the HQ MCP connector on the VPS. Run as root:  bash /opt/prathipan-hq/mcp/install.sh
set -euo pipefail
cd /opt/prathipan-hq/mcp
command -v node >/dev/null || { echo "Node.js missing: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"; exit 1; }
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
id hq-mcp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hq-mcp
if [ ! -f /etc/hq-mcp.env ]; then
  TOKEN=$(openssl rand -hex 24); PW=$(openssl rand -base64 24 | tr -d '/+=')
  URL=$(grep -o 'supabaseUrl: *"[^"]*"' /var/www/hq/config.js | cut -d'"' -f2); KEY=$(grep -o 'supabaseAnonKey: *"[^"]*"' /var/www/hq/config.js | cut -d'"' -f2)
  printf 'SUPABASE_URL=%s\nSUPABASE_KEY=%s\nAGENT_EMAIL=agent@prathipanholdings.cloud\nAGENT_PASSWORD=%s\nHQ_MCP_TOKEN=%s\nHQ_MCP_WRITES=on\nPORT=8787\n' "$URL" "$KEY" "$PW" "$TOKEN" > /etc/hq-mcp.env
  echo "Created /etc/hq-mcp.env"
fi
chown root:root /etc/hq-mcp.env; chmod 600 /etc/hq-mcp.env
sed "s#/usr/bin/node#$(command -v node)#" hq-mcp.service > /etc/systemd/system/hq-mcp.service
systemctl daemon-reload; systemctl enable hq-mcp >/dev/null 2>&1 || true
set -a; . /etc/hq-mcp.env; set +a
echo
echo "================  NEXT  ================"
echo "1. Supabase → Authentication → Users → Add user → Create new user:"
echo "      email:    $AGENT_EMAIL"
echo "      password: $AGENT_PASSWORD"
echo "      tick 'Auto Confirm User'"
echo "2. Supabase → SQL Editor:  insert into public.members (email, role, companies) values ('$AGENT_EMAIL','Admin','\"all\"') on conflict (email) do update set role='Admin';"
echo "3. DNS: A record  mcp → this server's IP, then:  certbot --nginx -d mcp.prathipanholdings.cloud --redirect -n --agree-tos -m YOUR-EMAIL"
echo "4. bash /opt/prathipan-hq/deploy/harden.sh"
echo "5. Connector URL for Claude / n8n (keep it secret):"
echo "      https://mcp.prathipanholdings.cloud/$HQ_MCP_TOKEN/mcp"
echo "========================================"
