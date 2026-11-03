#!/usr/bin/env bash
#
# Off-site copy of the 6mans database.
#
# The bot's own hourly backups live in data/backups on the same SD card as the database,
# which protects against a bad write but not against the card dying. This takes a fresh,
# consistent snapshot (VACUUM INTO, the same method the bot uses -- a read lock, safe on a
# live database), gzips it, and commits it to a private GitHub repo. A snapshot is a few
# hundred KB; a year of them is well under GitHub's limits.
#
# Runs from cron on the Pi as the bot's user (see docs/OPERATIONS.md "Backups"):
#   30 3 * * * /home/chris/discordBot/scripts/offsite-backup.sh >> /home/chris/6mans-backups.log 2>&1
#
# Restore: scripts/restore-backup.sh <file.sqlite.gz>
set -euo pipefail

BOT_DIR="${BOT_DIR:-$HOME/discordBot}"
REPO_DIR="${BACKUP_REPO_DIR:-$HOME/6mans-backups}"
DB="$BOT_DIR/data/6mans.sqlite"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-90}"

STAMP=$(date +%Y-%m-%d)
OUT="$REPO_DIR/daily/6mans-$STAMP.sqlite.gz"

[ -f "$DB" ] || { echo "$(date -Is) no database at $DB"; exit 1; }
[ -d "$REPO_DIR/.git" ] || { echo "$(date -Is) $REPO_DIR is not a git clone"; exit 1; }
mkdir -p "$REPO_DIR/daily"

# VACUUM INTO refuses to overwrite, so the temp path must not exist yet.
TMP="$REPO_DIR/.snapshot-$$.sqlite"
rm -f "$TMP"
trap 'rm -f "$TMP"' EXIT

# better-sqlite3 is already in the bot's node_modules; no sqlite3 CLI on the Pi.
(
  cd "$BOT_DIR" && node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    db.prepare("VACUUM INTO ?").run(process.argv[2]);
    db.close();
  ' "$DB" "$TMP"
)

gzip -9 -c "$TMP" > "$OUT"

# Old working copies go; git history keeps every snapshot ever pushed.
find "$REPO_DIR/daily" -name '6mans-*.sqlite.gz' -mtime +"$KEEP_DAYS" -delete

cd "$REPO_DIR"
git add -A daily
if git diff --cached --quiet; then
  echo "$(date -Is) nothing new to push"
  exit 0
fi
git commit -q -m "snapshot $STAMP ($(stat -c%s "$OUT") bytes gzipped)"
git push -q origin HEAD
echo "$(date -Is) pushed $(basename "$OUT")"
