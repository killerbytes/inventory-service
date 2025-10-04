#!/bin/sh
set -e

# Ensure PATH is correct
export PATH=/usr/local/bin:/usr/bin:/bin
export NODE_ENV=production

# Railway already injects DB_* and other vars into the container,
# so we just forward them to node
echo "[$(date)] Running backup..."

node /app/backup.js backup
