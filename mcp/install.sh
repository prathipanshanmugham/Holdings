#!/bin/bash
# One-time install of the HQ MCP connector on the VPS. Run as root:  bash /opt/prathipan-hq/mcp/install.sh
set -e
cd /opt/prathipan-hq/mcp
command -v node >/dev/null || { echo "Node.js missing: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"; exit 1; }
npm install --omit=dev --no-audit --no-fund
if [ ! -f /etc/hq-mcp.env ]; then
  TOKEN=$(openssl rand -hex 24); PW=$(openssl rand -base64 18 | tr -d '/+=' )
  URL=$(grep -o 'supabaseUrl: *"[^"]*"' /var/www/hq/config.js | cut -d'"' -f2); KEY=$(grep -o 'supabaseAnonKey: *"[^"]*"' /var/www/hq/config.js | cut -d'"' -f2)
  printf 'SUPABASE_URL=%s\nSUPABASE_KEY=%s\nAGENT_EMAIL=agent@prathipanholdings.cloud\nAGENT_PASSWORD=%s\nHQ_MCP_TOKEN=%s\nPORT=8787\n' "$URL" "$KEY" "$PW" "$TOKEN" > /etc/hq-mcp.env
  chmod 600 /etc/hq-mcp.env; echo "Created /etc/hq-mcp.env"
fi
cp hq-mcp.service /etc/systemd/system/hq-mcp.service
cp nginx-mcp.conf /etc/nginx/sites-available/mcp; ln -sf /etc/nginx/sites-available/mcp /etc/nginx/sites-enabled/mcp
nginx -t && systemctl reload nginx
systemctl daemon-reload; systemctl enable hq-mcp >/dev/null 2>&1 || true
. /etc/hq-mcp.env
echo
echo "================  NEXT  ================"
echo "1. In Supabase → Authentication → Users → Add user → Create new user:"
echo "      email:    $AGENT_EMAIL"
echo "      password: $AGENT_PASSWORD"
echo "      tick 'Auto Confirm User'"
echo "2. In HQ → Users & roles → Add a person → $AGENT_EMAIL → role Admin (or Manager for selected companies)."
echo "3. Then:  systemctl restart hq-mcp && certbot --nginx -d mcp.prathipanholdings.cloud --redirect -n --agree-tos -m $(grep -o "owner_email', '[^']*" /opt/prathipan-hq/supabase/schema.sql | cut -d"'" -f3)"
echo "4. Connector URL for Claude / n8n:"
echo "      https://mcp.prathipanholdings.cloud/$HQ_MCP_TOKEN/mcp"
echo "   (or https://mcp.prathipanholdings.cloud/mcp with header  Authorization: Bearer $HQ_MCP_TOKEN)"
echo "========================================"
