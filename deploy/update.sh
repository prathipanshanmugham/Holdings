#!/bin/sh
# Pull the latest HQ and reload nginx. Run on the VPS: sh /opt/prathipan-hq/deploy/update.sh
set -e
cd /opt/prathipan-hq && git pull --ff-only && systemctl reload nginx && echo "HQ updated"
