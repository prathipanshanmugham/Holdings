#!/bin/bash
# Replace the connector's access token and the agent's password. Run as root:  bash /opt/prathipan-hq/deploy/rotate-secrets.sh
# Fully automatic: the agent changes its own password, so no password is ever displayed.
set -euo pipefail
F=/etc/hq-mcp.env; [ -f $F ] || { echo "Connector not installed"; exit 1; }
cd /opt/prathipan-hq/mcp
set -a; . $F; set +a
NEW_PASSWORD="$(openssl rand -base64 30 | tr -d '/+=')a9"; TOKEN=$(openssl rand -hex 24)
if ! NEW_PASSWORD="$NEW_PASSWORD" node rotate.mjs; then
  echo
  echo "The agent's current password in $F doesn't match Supabase."
  echo "Reset it once: Supabase → Authentication → Users → agent@prathipanholdings.cloud → ⋯ → Delete user,"
  echo "then Add user → Create new user with the same email, tick Auto Confirm, and use the password from:"
  echo "   grep AGENT_PASSWORD $F"
  echo "Then run this script again."
  exit 1
fi
sed -i "s|^HQ_MCP_TOKEN=.*|HQ_MCP_TOKEN=$TOKEN|; s|^AGENT_PASSWORD=.*|AGENT_PASSWORD=$NEW_PASSWORD|" $F; chmod 600 $F
systemctl restart hq-mcp; sleep 3
for f in /var/log/nginx/*.log /var/log/nginx/*.log.1; do [ -f "$f" ] && truncate -s0 "$f"; done
rm -f /var/log/nginx/*.gz
if systemctl is-active --quiet hq-mcp; then
  echo; echo "Done. New password set (not shown). Old web logs cleared."
  echo "In claude.ai → Settings → Connectors, edit the HQ connector and paste this new URL (don't share it anywhere else):"
  echo; echo "   https://mcp.prathipanholdings.cloud/$TOKEN/mcp"; echo
else echo "Connector didn't start: journalctl -u hq-mcp -n 30"; fi
