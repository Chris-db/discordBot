#!/usr/bin/env bash
#
# Puts a snapshot back as the live database.
#
#   scripts/restore-backup.sh ~/6mans-backups/daily/6mans-2026-09-11.sqlite.gz
#
# Stops the bot first (a restore under a running bot would be overwritten by its next
# write), keeps the current database next to it as *.replaced-<time>, and starts the bot
# again. Needs sudo for the service stop/start; run it from an interactive shell.
set -euo pipefail

SNAPSHOT="${1:?usage: restore-backup.sh <file.sqlite.gz>}"
BOT_DIR="${BOT_DIR:-$HOME/discordBot}"
DB="$BOT_DIR/data/6mans.sqlite"
SERVICE="${SERVICE:-6mans}"

[ -f "$SNAPSHOT" ] || { echo "no such file: $SNAPSHOT"; exit 1; }

echo "Stopping $SERVICE..."
sudo systemctl stop "$SERVICE"

if [ -f "$DB" ]; then
  KEEP="$DB.replaced-$(date +%Y%m%d-%H%M%S)"
  mv "$DB" "$KEEP"
  rm -f "$DB-wal" "$DB-shm"
  echo "Current database kept as $KEEP"
fi

gunzip -c "$SNAPSHOT" > "$DB"
echo "Restored $(basename "$SNAPSHOT") -> $DB"

sudo systemctl start "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager | head -5
