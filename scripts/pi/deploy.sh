#!/usr/bin/env bash
# Deploy whatever is on origin/main, if it has moved. Run by 6mans-deploy.timer.
#
# Order matters: fetch -> fast-forward -> (npm ci if the lockfile changed) -> test ->
# build into a scratch dir -> swap it in -> restart. A failing test or build puts the
# source back where it was, leaves the running bot alone, and opens a GitHub issue
# (once per commit) so the failure is seen even when nobody is watching the journal.
#
# The restart is the one step that needs root. /etc/sudoers.d/6mans-deploy allows exactly
# that command without a password (see scripts/pi/README.md). If the restart fails, the
# built code is on disk but not running -- so a marker remembers it, and every later tick
# retries the restart until it works.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/chris/discordBot}"
SERVICE="${SERVICE:-6mans}"
RESTART_MARKER="data/.restart-pending"
cd "$REPO_DIR"

# .env holds GITHUB_REPO / GITHUB_TOKEN; the bot uses them too. Missing = no issue, just logs.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

fence() { # fence TEXT -- wrap in a markdown code block
  printf '```\n%s\n```' "$1"
}

report() { # report TITLE BODY -- one issue per failing commit
  local title="$1" body="$2" marker="data/.deploy-reported-${remote:-unknown}"
  echo "deploy: $title"
  [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ] || return 0
  [ -e "$marker" ] && return 0
  local payload
  payload=$(node -e 'const [t,b]=process.argv.slice(1);process.stdout.write(JSON.stringify({title:t,body:b,labels:["deploy-failed"]}))' "$title" "$body")
  curl -sS -o /dev/null -X POST "https://api.github.com/repos/$GITHUB_REPO/issues" \
    -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" -d "$payload" && touch "$marker" || true
}

restart_bot() {
  if ! sudo -n systemctl restart "$SERVICE" 2>/dev/null; then
    touch "$RESTART_MARKER"
    report "[deploy-failed] built $remote but could not restart $SERVICE" \
"Restarting needs root and the deploy timer has no way to type a password. On the Pi, run once:

$(fence "echo 'chris ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE' | sudo tee /etc/sudoers.d/6mans-deploy >/dev/null && sudo chmod 440 /etc/sudoers.d/6mans-deploy")

The next timer tick (within 5 minutes) will restart the bot. Until then it is running the previous build."
    exit 1
  fi
  rm -f "$RESTART_MARKER"
  sleep 8
  if systemctl is-active --quiet "$SERVICE"; then
    echo "deploy: $remote is live"
  else
    report "[deploy-failed] $SERVICE not active after deploying $remote" "$(fence "$(journalctl -u "$SERVICE" -n 60 --no-pager 2>&1)")"
    exit 1
  fi
}

git fetch -q origin main
current=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
if [ "$current" = "$remote" ]; then
  if [ -e "$RESTART_MARKER" ]; then
    echo "deploy: $remote is built but not yet running; retrying restart"
    restart_bot
  fi
  exit 0
fi
echo "deploy: $current -> $remote"

rollback() {
  git reset -q --hard "$current"
  if git diff --quiet "$current" "$remote" -- package-lock.json; then :; else npm ci --no-audit --no-fund >/dev/null 2>&1 || true; fi
}

git merge -q --ff-only origin/main

if ! git diff --quiet "$current" "$remote" -- package-lock.json; then
  echo "deploy: lockfile changed, npm ci"
  if ! out=$(npm ci --no-audit --no-fund 2>&1); then
    rollback
    report "[deploy-failed] npm ci failed on $remote" "$(fence "$(echo "$out" | tail -60)")"
    exit 1
  fi
fi

if ! out=$(npx vitest run 2>&1); then
  rollback
  report "[deploy-failed] tests failed on $remote" "Deploy of \`$remote\` stopped; the bot is still running \`$current\`.

$(fence "$(echo "$out" | tail -80)")"
  exit 1
fi

rm -rf dist.new
if ! out=$(npx tsc --outDir dist.new 2>&1); then
  rm -rf dist.new
  rollback
  report "[deploy-failed] build failed on $remote" "$(fence "$(echo "$out" | tail -60)")"
  exit 1
fi
rm -rf dist && mv dist.new dist
restart_bot
