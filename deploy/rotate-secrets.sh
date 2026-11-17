#!/bin/bash
# Replace the connector's access token and agent password. Run as root:  bash /opt/prathipan-hq/deploy/rotate-secrets.sh
set -euo pipefail
F=/etc/hq-mcp.env; [ -f $F ] || { echo "Connector not installed"; exit 1; }
TOKEN=$(openssl rand -hex 24); PW=$(openssl rand -base64 24 | tr -d '/+=')
EMAIL=$(grep '^AGENT_EMAIL=' $F | cut -d= -f2)
echo
echo "1) In Supabase → SQL Editor, run this one line, then come back here:"
echo
echo "   update auth.users set encrypted_password = extensions.crypt('$PW', extensions.gen_salt('bf')) where email = '$EMAIL';"
echo
read -r -p "Press Enter after it says Success… " _
sed -i "s|^HQ_MCP_TOKEN=.*|HQ_MCP_TOKEN=$TOKEN|; s|^AGENT_PASSWORD=.*|AGENT_PASSWORD=$PW|" $F; chmod 600 $F
systemctl restart hq-mcp; sleep 3
for f in /var/log/nginx/*.log; do [ -f "$f" ] && truncate -s0 "$f"; done
if systemctl is-active --quiet hq-mcp; then
  echo; echo "2) Done. In claude.ai → Settings → Connectors, edit the HQ connector and paste the new URL:"; echo
  echo "   https://mcp.prathipanholdings.cloud/$TOKEN/mcp"; echo
  echo "   The old URL stops working now. Old web logs were cleared."
else echo "Connector didn't start — the SQL line probably wasn't run. Run it, then: systemctl restart hq-mcp"; fi
