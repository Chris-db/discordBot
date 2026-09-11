#!/usr/bin/env bash
# Deploy whatever is on origin/main, if it has moved. Run by 6mans-deploy.timer.
#
# Order matters: fetch -> fast-forward -> (npm ci if the lockfile changed) -> test ->
# build into a scratch dir -> swap it in -> restart. A failing test or build puts the
# source back where it was, leaves the running bot alone, and opens a GitHub issue
# (once per commit) so the failure is seen even when nobody is watching the journal.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/chris/discordBot}"
SERVICE="${SERVICE:-6mans}"
cd "$REPO_DIR"

# .env holds GITHUB_REPO / GITHUB_TOKEN; the bot uses them too. Missing = no issue, just logs.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

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

git fetch -q origin main
current=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
[ "$current" = "$remote" ] && exit 0
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
    report "[deploy-failed] npm ci failed on $remote" "$(printf '```\n%s\n```' "$(echo "$out" | tail -60)")"
    exit 1
  fi
fi

if ! out=$(npx vitest run 2>&1); then
  rollback
  report "[deploy-failed] tests failed on $remote" "Deploy of \`$remote\` stopped; the bot is still running \`$current\`.

$(printf '```\n%s\n```' "$(echo "$out" | tail -80)")"
  exit 1
fi

rm -rf dist.new
if ! out=$(npx tsc --outDir dist.new 2>&1); then
  rm -rf dist.new
  rollback
  report "[deploy-failed] build failed on $remote" "$(printf '```\n%s\n```' "$(echo "$out" | tail -60)")"
  exit 1
fi
rm -rf dist && mv dist.new dist

sudo systemctl restart "$SERVICE"
sleep 8
if systemctl is-active --quiet "$SERVICE"; then
  echo "deploy: $remote is live"
else
  report "[deploy-failed] $SERVICE not active after deploying $remote" "$(printf '```\n%s\n```' "$(journalctl -u "$SERVICE" -n 60 --no-pager 2>&1)")"
  exit 1
fi
