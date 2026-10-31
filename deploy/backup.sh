#!/usr/bin/env bash
# Daily database backup, run from cron on the server:
#   15 3 * * * /home/deploy/orgpay/deploy/backup.sh >> /home/deploy/orgpay-backups/backup.log 2>&1
# Keeps the last 14 dumps in $BACKUP_DIR. Copy them off the server too (rclone to S3/B2, or a
# Hetzner Storage Box): a backup on the same disk is not a backup.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/orgpay-backups}"
KEEP="${KEEP:-14}"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/orgpay-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec orgpay-postgres pg_dump -U orgpay -d orgpay -Fc > "$file.tmp"
mv "$file.tmp" "$file"
echo "$(date -u +%FT%TZ) wrote $file ($(du -h "$file" | cut -f1))"
ls -1t "$BACKUP_DIR"/orgpay-*.dump | tail -n +"$((KEEP + 1))" | xargs -r rm --
# Restore (into an empty database): docker exec -i orgpay-postgres pg_restore -U orgpay -d orgpay --clean < file.dump
