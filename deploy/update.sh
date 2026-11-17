#!/bin/bash
# Pull the latest HQ and apply it. Run on the VPS:  bash /opt/prathipan-hq/deploy/update.sh
set -euo pipefail
cd /opt/prathipan-hq
OLD=$(git rev-parse HEAD); git pull -q --ff-only; NEW=$(git rev-parse HEAD)
changed(){ ! git diff --quiet "$OLD" "$NEW" -- "$@"; }
if changed mcp/package-lock.json; then (cd mcp && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error); fi
if changed mcp/ && systemctl list-unit-files hq-mcp.service >/dev/null 2>&1; then systemctl restart hq-mcp; echo "Connector restarted"; fi
nginx -t 2>/dev/null && systemctl reload nginx
echo "HQ updated: $(git log --oneline -1)"
if changed deploy/nginx-hq.conf deploy/nginx-limits.conf mcp/nginx-mcp.conf mcp/hq-mcp.service deploy/harden.sh; then echo "→ Server settings changed: run  bash deploy/harden.sh"; fi
if changed supabase/; then echo "→ Database files changed: run the new SQL in Supabase → SQL Editor (see README)"; fi
