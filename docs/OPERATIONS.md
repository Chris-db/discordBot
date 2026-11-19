# Operations

Running, deploying, testing and rescuing the bot. Architecture is in `ARCHITECTURE.md`.

## Where it runs

The bot runs on the Raspberry Pi (reached over SSH as `<pi-host>`, user `chris`) as the systemd service
`6mans.service`, from a clone at `/home/chris/discordBot`. `main` on GitHub is the source of
truth. The Pi is the permanent host; a VPS only if funding turns up.

**Never run the production bot on Windows while the Pi's copy is up.** Two processes on
one token race every interaction (`DiscordAPIError[10062]`). Windows is for building,
testing, and the dev bot below.

## Shipping a change

**Merge to `main`; the Pi does the rest.** `6mans-deploy.timer` runs `scripts/pi/deploy.sh`
every 15 minutes. If `origin/main` moved, it fast-forwards, runs `npm ci` if the lockfile
changed, runs the tests, builds into `dist.new`, swaps it in and restarts `6mans`. A failing
test or build rolls the source back, leaves the running bot alone, and opens a
`deploy-failed` issue. Install steps are in `scripts/pi/README.md`.

Slash commands re-register on every boot and on joining a server, so `npm run register`
is not needed for a deploy.

CI (`.github/workflows/test.yml`) runs typecheck and tests on Node 24 for every PR.

On the Pi:

```bash
ssh chris@<pi-host>
sudo systemctl start 6mans-deploy.service      # deploy now instead of waiting
journalctl -u 6mans-deploy -n 30 --no-pager    # what the last deploy did
journalctl -u 6mans -f                         # bot logs
```

## Errors and feedback

Both become GitHub Issues (`src/services/errorReporter.ts`, `feedbackService.ts`,
`github.ts`):

- Every `logger.error` becomes one issue labelled `bot-error`, fingerprinted. Repeats are
  comments, at most one an hour; an error that comes back after its issue was closed opens
  a new one. Each report carries the stack, the commit and the log lines before it.
- `/feedback <message>` would file an issue labelled `feedback`, but the command is
  switched off (2026-11-19): nobody used it, and the repo is going public. The comment
  under `commands` in `src/handlers/commandHandler.ts` says how to bring it back.
- Hard cap of 30 GitHub calls an hour. State lives in `data/error-reports.json` on the Pi.
- Needs `GITHUB_REPO` and `GITHUB_TOKEN` in the Pi's `.env` (a fine-grained PAT for this
  repo only, Issues read and write).

`MONITOR.md` describes the cloud routine that used to triage these every 6 hours. It is
disabled; Chris triages by hand.

## Uptime heartbeat

The bot pings `HEARTBEAT_URL` every `HEARTBEAT_INTERVAL_MINUTES` (default 5) while its
gateway is connected (`src/services/heartbeat.ts`). Healthchecks.io alerts when the pings
stop, to Telegram and email. A dead Pi, a hung process, a crash loop and a dropped gateway
all look the same: silence. The log prints only the host, never the URL, because the URL
is a secret.

To rebuild it: create a Healthchecks.io check (period 5 min, grace 5 min), put the ping URL
in `HEARTBEAT_URL` in `~/discordBot/.env` on the Pi, restart `6mans`, and look for
`Heartbeat: pinging hc-ping.com every 5 min` in the log. To prove it, stop the service,
wait about 10 minutes for the alert, then start it again.

## Backups

- **On the Pi:** one `VACUUM INTO` snapshot a day in `data/backups/` (checked hourly, so a
  restart never skips a day; `BACKUP_RETENTION_DAYS`, default 14). They live on the same SD card, so they cover a bad write, not a dead card.
- **Off-site:** `scripts/offsite-backup.sh` runs from Chris's crontab at 03:30 SAST and
  pushes `daily/6mans-YYYY-MM-DD.sqlite.gz` to the private repo `Chris-db/6mans-backups`
  (the clone is `~/6mans-backups`, the log `~/6mans-backups.log`). One commit a night; the
  working tree keeps 90 days and git history keeps everything.
- **Restore:** on the Pi, `scripts/restore-backup.sh ~/6mans-backups/daily/<file>.sqlite.gz`
  stops the service, keeps the current DB as `*.replaced-<time>`, unpacks and starts. It
  needs an interactive shell for sudo. If the Pi is gone: clone the backups repo anywhere,
  `gunzip` the file to `data/6mans.sqlite` on the new host, and deploy as usual.

## Testing a branch on the dev bot

A second Discord application, "6mans Dev", with its own token, invited only to the
throwaway test server. Run it from Windows on the branch:

```bash
ENV_FILE=.env.dev npm run dev
```

`.env.dev` (gitignored) carries the dev token and client id, `DB_PATH=data/dev.sqlite` and
`TEST_GUILD_IDS=<test server id>`, so it starts from an empty ladder: run `/setup` in the
test server, then `/queue fill-bots`.

**Test bots** (`/queue fill-bots`, `force-pop`) only run in servers listed in
`TEST_GUILD_IDS`, in both `.env` files. They leave real leaderboard rows, so never list a
live server. To clear them out of one server, back up first, then delete
`discord_id LIKE 'test_bot_%'` for that `guild_id` from `player_ladders` and `players`. Old
matches can keep their bot ids; the code skips them.
In the slash-command popup pick the dev bot's copy (Discord shows the bot avatar); buttons
always go to the bot that posted the card. Invite it with Administrator, or with
`&permissions=288484368` on the invite URL.

`docs/TESTING.md` is the checklist for a live run.

## Diagnosing

**Everything is slow.** Check, on the Pi: `pgrep -af "node.*dist"` (exactly one process),
`uptime`, `free -m`, `curl -w %{time_total}` against `discord.com/api/v10/gateway` with and
without a 200 KB `-F` upload, and `journalctl -u 6mans | grep -iE "warn|error|429"`. One
process and fast curls means it is not the Pi; slow image cards on a good Pi have been
Discord's CDN before. `journalctl -u 6mans | grep "Avatar for user"` shows avatar fetch
timeouts (4 s deadline, `AVATAR_FETCH_TIMEOUT_MS`).

**Restart loop or a Discord outage.** Login retries with backoff (5 s up to 60 s) forever
for passing failures; only an invalid token or disallowed intents are fatal.

```bash
journalctl -u 6mans --since "YYYY-MM-DD HH:MM" --until "YYYY-MM-DD HH:MM" | grep -E "restart counter|Logged in|Failed to log in"
```

**A queue panel appears in the wrong channel.** Only channels registered in
`guild_divisions` keep a panel; `sweepStrayQueuePanels` removes the rest on the next
restart.

**"Player X is not on the leaderboard."** Usually not a bug: a player has a row only on the
sizes they have queued. `/leaderboard` defaults to 3v3; try `size:2v2`.
