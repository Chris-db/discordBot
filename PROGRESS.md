# 6mans Bot — Build Progress

Tracker for a multi-session build. Update this before ending a session.

Last updated: 2026-09-12 (Double or Nothing wheel, branch gamble-wheel)

---

## Read first

- `TESTING.md` — the ordered checklist for the first live session, and what should happen
  at each step. Nothing here has ever run against Discord.

- `AUDIT.md` — the full codebase audit. Still the source of truth for what's wrong.
- `feature_plan1.md` — **treat as a menu of ideas, not a spec.** It is stale and partly
  contradicts agreed design (see "Where the plan is wrong" below).
- Project memory (`discord-6mans-bot`) — the agreed design decisions.

## Status: deployed on the Pi as a systemd service

Since 2026-09-10 the bot runs on the Raspberry Pi (`pi5.local`, user `chris`) as
`6mans.service`, from a clone at `/home/chris/discordBot`. `main` on GitHub is the source
of truth; the Pi pulls it. Windows is for building and testing only — never run the bot
here while the Pi's copy is up (two processes on one token race every interaction).

**Ship loop (since 2026-09-11): merge to `main`, the Pi does the rest.** A systemd timer
on the Pi (`6mans-deploy.timer`, every 15 min, units + script in `scripts/pi/`) fetches
`origin/main`; if it moved it fast-forwards, runs `npm ci` if the lockfile changed, runs
the tests, builds into `dist.new`, swaps it in and restarts `6mans`. A failing test or
build rolls the source back, leaves the running bot alone, and opens a `deploy-failed`
issue. Slash commands re-register on every boot, so `npm run register` is never needed.

Manual fallback, on the Pi:

```
ssh chris@pi5.local
cd ~/discordBot && sudo systemctl start 6mans-deploy.service
journalctl -u 6mans-deploy -n 30 --no-pager
```

Read bot logs with `journalctl -u 6mans -f`.

**Errors and feedback go to GitHub Issues** (`src/services/errorReporter.ts`,
`feedbackService.ts`). Every `logger.error` becomes one issue labelled `bot-error`
(fingerprinted; repeats are comments, at most one an hour; a closed-then-back error is a
fresh issue). `/feedback <message>` files an issue labelled `feedback`. Both need
`GITHUB_REPO` + `GITHUB_TOKEN` in the Pi's `.env` (fine-grained PAT, this repo only,
Issues read+write). State lives in `data/error-reports.json` on the Pi. Hard cap of 30
GitHub calls an hour. CI (`.github/workflows/test.yml`) runs typecheck + tests on every PR.

Local development only: never run the bot on Windows while the Pi's copy is up (two
processes on one token race every interaction).

Phases 1–5 are **merged to `main` and running**. Migrations 1–4 applied cleanly to the
real `data/6mans.sqlite` on 2026-08-09 (six players kept their exact MMR on the 3v3
ladder).

Matches #5 and #7 played end to end in Discord: queue → ready check → mode vote →
teams/captains → lobby → report → MMR and streaks. Two bugs came out of that session and
are fixed (see gotchas below).

Chris does **not** care about the pre-existing data, so the migration's legacy-upgrade
path is for onboarding a future second server, not a constraint on his own database.

A pre-migration snapshot is at `data/6mans.pre-phase5.sqlite` if anything needs rolling
back. All the feature branches still exist; `git reset --hard 818432c` returns `main` to
where it was before phase 5.

## Live setup as of 2026-09-11

All five 3v3 divisions have their own channel on the server, each in its own Discord
category, and a Rank B match has been played end to end through the new channels:

| Division | Channel id |
|---|---|
| S | `1532714997568897024` (the original queue channel) |
| X | `1547878777936154655` |
| A | `1547878982345695292` |
| B | `1547879043058114560` |
| C | `1547879120459931679` |

Chris placed his regulars into S and himself into B for the test (`/division place`
with the default `keep-mmr:false`, so they sit on S's 1900 default now). The test bots
are still C; `/queue fill-bots` bypasses the division gate on purpose.

The queue panel takes its division's colour on the accent line and badge, and its title
is `RANK B 3V3 QUEUE` — no emoji, at Chris's request. Sidebar styling (category and
channel names, role colours) is Discord-side and Chris's; the bot's only naming is
`match-N`, `🔊 Ready Check #N`, `🔵 Team Blue [Match #N]`, `🟠 Team Orange [Match #N]`.

## Still unexercised in Discord

Everything else worked, but these have never been run against the real API:

- ~~Reporting by **button vote**~~ — worked in the trial run, 2026-09-11.
- **2v2 and 4v4** in any form — no channel is registered to a size yet.
- ~~Double or Nothing.~~ — worked, 2026-09-11. **The new wheel GIF (branch `gamble-wheel`) is not yet.**
- ~~Rematch actually starting~~ — worked, 2026-09-11 (channel rename bug found and fixed).
- ~~`/replay check` against a real upload~~ — Chris tested it live in an earlier session (with a
  cross-reference against the match); worked. Not recorded at the time.
- ~~A second division channel (Rank B) end to end.~~ Played 2026-09-11.

Tests: **366 passing**. `npx tsc --noEmit` clean. `npm run build` clean.

## Done

| Phase | What |
|---|---|
| 1 | Six P0 bugs (ordering, queue deletion, vote races, ready-check re-pop, stale matches, restart recovery) + nightly SQLite backups |
| P1s | Balanced re-roll stays balanced; mode-vote ties are a coin flip; `/ban 30m` = minutes; banning removes from waiting queues |
| 2 | Migration runner (`schema_migrations`, transactional, fatal on error); `players` keyed on `(guild_id, discord_id)`; stored rank divisions; seasons with hard reset + promotion/relegation; `/division`, `/season`; `getRankTier` deleted |
| 3 | Rematch (same teams, new match row, `series_id`), Back-to-Queue button, cancellable channel teardown, dynamic `updateMatch` |
| 4 | Streak badges on result card + queue panel; promotion-zone moments; **Inter + Noto Color Emoji bundled** in `assets/fonts` |
| 5 | Multi-queue at 2v2 / 3v3 / 4v4, with each size a fully separate ladder |

## Queue-sequence audit (2026-09-10)

A full read of queue → ready check → votes → draft → match → post-match, with two findings
confirmed by probe tests. Landed on `main` the same day:

- **Cross-queue double match** — a pop now strips its roster from every other waiting
  queue, and never pops with a player who already has a live match.
- **Not-ready button** on the ready-check card: fails the check early, the others go to
  the front of the queue. No AFK cooldown yet — policy decision for Chris.
- A re-pop moves the players who showed up into the new VC instead of kicking them.
- Ready-check ticks can no longer overlap.
- Every vote card carries a live `<t:…:R>` deadline and says what silence does.
  `VOTE_TIMEOUT_SECONDS` (default 60) replaces the hidden 30s.
- A proposed Double or Nothing holds the channel open; a gamble is void once a rematch
  or requeue sets `rematchResolved`. Post-match countdowns are live timestamps.

Landed in the follow-up session (same day, all on `main`):
- Re-roll cap: three re-rolls, then the next pair/split is final. Seen-caps use the real
  pool size per lobby (`captainPairCount`, `matchupCount`).
- Finalizers run under a per-channel lock, so a timer and a click cannot resolve a vote
  twice. Tripwire test fails on the old code.
- Startup + periodic sweep for match channels orphaned by a restart; a restart-cancelled
  setup now posts a "re-queue to play" notice in the rank channel.
- Split reports (neither side can still reach the majority) post one notice to the match
  channel and one to the feed, with the `/match report` command to settle it.
- **Mod Override button removed.** Discord cannot hide a button per viewer; `/match` is the
  admin surface, hidden by `setDefaultMemberPermissions`, and `match_id` defaults to the
  match in the current channel. **Requires `npm run register` on deploy.**
- Join/Leave reply before the panel re-renders; panel refresh is one API call, not three.

**Policy calls, decided by Chris on 2026-09-11 and shipped:**
- AFK cooldown: **5 minutes** (`AFK_COOLDOWN_MINUTES`, 0 disables). A timed ban row with reason `Missed the ready check`; the join message reads as a cooldown, `/ban remove` lifts it early.
- Rematch window: **3 minutes** (`REMATCH_WINDOW_MS`), up from 90s.

## Audit leftovers (2026-09-10, third session)

Everything in `AUDIT.md` P2-14 and Part 5 that was still open, plus the two cheapest UX
items. All on `main`; nothing here needs `npm run register`.

- **Boot hardening.** `validateConfig()` refuses to start on a missing token/client id or
  a non-numeric timeout (a typo used to parse to NaN and make that timeout "never").
  `uncaughtException` now exits(1) — the Pi's `Restart=always` brings a clean process
  back in ~1s and `recoverStuckQueues` cleans up — instead of carrying on with half-written
  state. The **MessageContent intent is dropped**; nothing read message content. You can
  untick it in the Developer Portal too, but nothing breaks if you don't.
- `/queue clear` inside `#match-N` now refuses and points at `/match cancel` (it used to
  wipe the lobby row and leave the match live). The rank-channel path clears every vote
  state, which it had drifted from.
- `ephemeral: true` → `flags: MessageFlags.Ephemeral` across all 81 sites. discord.js
  logs a deprecation warning for the boolean.
- ~~Queue wait line~~ — shipped, then **removed on 2026-09-11 at Chris's request** (redundant next to the 3/6 in the image). The panel message has no text again.
- Draft card subtext shows the pick order (`🔵 🟠🟠 · last player → 🔵`); lobby name and
  password sit on separate lines so a copy grabs one.

Not done from the audit, on purpose: the "typically pops in ~N min" estimate needs
queue-to-pop history the schema does not keep; party/duo support and MMR preview on the
teams vote are features, not fixes — ask Chris before building either.

## Stray panel in #general (2026-09-10, fourth session)

Chris reported a queue panel re-posting itself into #general on every chat message. The
live DB had a second `active_queues` row for #general with a `message_id`: an admin
`/queue` subcommand run there had created the row (`getOrInitQueue`) and posted a panel,
and a row with a message id was all `handleChannelMessage` needed to keep re-pinning it.

Fixed on `main`:
- **`guild_divisions.queue_channel_id` is now the single truth for "this channel has a
  panel".** `/queue panel` registers the channel every time (lowest division by default),
  and the chat re-pin ignores unregistered channels.
- `/queue add`, `/queue clear`, `fill-bots` and `force-pop` refuse in a channel with no
  queue row instead of creating one.
- **Boot sweep `sweepStrayQueuePanels`**: an empty, idle queue row in an unregistered
  channel has its panel message and row deleted — only in guilds that have at least one
  registered channel, so a fresh server's first panel is safe. This is what cleans up
  #general on the next restart; no manual step.

**"ravi_rl1 is not on the leaderboard" is not a bug.** ravi has only played 2v2 (match #7,
when the channel was registered at 2v2), so their only ladder row is the 2v2 one.
`/leaderboard` defaults to 3v3; `/leaderboard size:2v2` shows them. A player gets a row on
a ladder the first time they join a queue of that size. If Chris wants one ladder across
sizes, that is a design reversal of the 2026-08-08 decision, not a fix.

## Replay reader + multi-channel divisions (2026-09-11)

Chris confirmed the **one division per player per size** model is what he wants (the
other 6mans server let people queue in several divisions and he disliked it). What
landed to make multi-channel divisions real and to give admins a dispute tool:

- **Join is gated by division.** A registered channel refuses a player whose stored
  division differs from the channel's, with a pointer to their own queue. `/queue add`
  by an admin still overrides. Unregistered channels are not gated. Setup for a second
  division: create the channel, `/queue panel division:B` in it, `/division place` the
  players. Discord role permissions on the channel are still worth setting (they hide the
  channel); the bot check is the backstop.
- **`/replay check file1…file5 [match_id]`** (admin, works in any channel — no admin
  channel registration needed). Downloads the `.replay` attachments, parses the header
  only (`src/utils/replayHeader.ts`, ~200 lines, no library) and posts one scoreboard per
  game, the series tally, and warnings (duplicate file, not a private match, wrong size,
  played before the match started). It never changes a result; `/match report` does.
  **Requires `npm run register`.**
- `/match list` shows state, ladder, the match's own channel and start time, and stays
  up for two minutes.

**Replay format facts, verified against all 260 replays on Chris's PC:**
- The header (first ~5–20KB) carries `Team0Score`, `Team1Score`, `WinningTeam`,
  `MatchStartEpoch`, `MatchType`, `Date`, and `PlayerStats` (name, team, platform id,
  goals/assists/saves/score). The network stream is never read.
- A property at its default is **omitted** — a missing `Team0Score` means 0.
- `WinningTeam` only exists in newer replays. The score decides; `WinningTeam` only
  settles a level score (a forfeit), and its presence with value 0 means Blue.
- `ByteProperty` with enum name `None` (PSN id padding fields `Term`/`Dummy`) is
  followed by **one raw byte**, not a string. Missing this desyncs 90% of files.
- Epic ids live in `PlayerID.EpicAccountId`; Steam/PSN in `OnlineID`. Old files have
  neither for some players.
- Rocket League has **no auto-save for replays** and no match-result log. `Launch.log`
  does write `ScriptLog: Match Ended` plus the private server address the moment a game
  ends — a clean trigger for a watcher — but no score. Any auto-report design needs a
  program on a player's PC; parked, see the conversation of 2026-09-11.

## Themes (2026-09-11)

Chris asked for a styling preset he can set himself instead of asking for each colour.
Two commits:

1. **`src/ui/palette.ts`** — every colour the ten image files draw with, as named tokens
   on one object (`P`). ~200 literals replaced; **no pixel changed**, proven by
   `scripts/renderAll.ts` (renders all 13 cards with fixed data; a run before and after is
   byte-identical). Tints come from `alpha()` / `overlay()` so an overridden base colour
   carries them. Run the script after touching any image code:
   `DB_PATH=/tmp/x.sqlite npx ts-node scripts/renderAll.ts out/`
2. **Per-server themes.** Migration 5 adds `guild_themes(guild_id, theme JSON)` holding
   only the overrides. `P` is an `AsyncLocalStorage`-backed proxy: every interaction and
   chat event runs inside `withGuildTheme(guildId, …)` (index.ts), the per-guild
   background loops wrap their renders, and timers scheduled inside inherit the context.
   Outside any context `P` is the default. `getDivisionTier` reads its colour at call
   time for the same reason.

**`/theme`** (Manage Server): `set token colour` (22 tokens as a dropdown, hex typed),
`reset [token]`, `preset default|mono|midnight|ember`, `list`, `show`. Every mutating
subcommand replies with a rendered queue panel + result card under the new theme.
**Requires `npm run register`.** Verified live 2026-09-11: `/theme show` and `/theme set` both work on the Pi.

Not themed, on purpose: Discord embed side-bars (`RL_COLORS` in `ui/embeds.ts`, a few
`setColor` calls) — those are the messages, which Chris is happy with; and the
card-specific groups (`matchVs`, `gamble`, `leaderboard` medals, `history`) which keep
their defaults except that `queueBg` follows an overridden `bgTop`/`bgBottom`.

## Off-site backups (2026-09-11)

The bot's hourly `VACUUM INTO` backups in `data/backups/` are on the same SD card as the
database, so they cover a bad write, not a dead card. The off-site layer:

- **Where:** private repo `github.com/Chris-db/6mans-backups`, `daily/6mans-YYYY-MM-DD.sqlite.gz`
  (~8KB gzipped today; git history keeps every snapshot, the working tree keeps 90 days).
- **How:** `scripts/offsite-backup.sh` on the Pi, from Chris's user crontab at **03:30
  SAST nightly**, logging to `~/6mans-backups.log`. Pushes over the Pi's existing
  account-level SSH key. The clone lives at `~/6mans-backups`.
- **Verified 2026-09-11:** the first snapshot was cloned back on Windows, `integrity_check`
  ok, schema version 5, 10 players / 10 matches / 14 ladder rows.
- **Restore:** on the Pi, `scripts/restore-backup.sh ~/6mans-backups/daily/<file>.sqlite.gz`
  — stops the service, keeps the current DB as `*.replaced-<time>`, unpacks, starts. Needs
  an interactive shell for sudo. If the Pi itself is gone: clone the repo anywhere,
  `gunzip` the file to `data/6mans.sqlite` on the new host, deploy as usual.
- **Check it is still running:** `tail ~/6mans-backups.log` on the Pi, or look at the
  repo's commit list — one commit per night.

## Second-guild test (2026-09-11)

Chris made a throwaway server and invited the bot. Two findings, both fixed on `main`:

- **Slash commands were missing** in the new server: registration was per-guild against
  `GUILD_ID` only. Now registers to every guild on boot and on `GuildCreate` (8f0dde5).
- **A guild that joins after migration 2 had no `guild_divisions` rows at all.** The seed
  only ever ran inside migration 2 for guilds present at the time. Symptoms on the test
  server: `/queue panel division:C` posted the *unregistered* panel (🚀 `3V3 MATCH QUEUE`
  title) because `updateDivision` updated a row that did not exist; divisions, placement,
  promotion and the join gate were inert. `ensureGuildDefaults()` (`src/services/guildSetup.ts`)
  now runs for every guild on boot, on `GuildCreate`, and inside `/queue panel`. Idempotent.
  **This would have hit the first real trial server on day one.**

Second-guild run **passed** after the fix: a bot match in the test server while a queue sat in the
real one; nothing crossed over. Deploy step was: re-run `/queue panel division:C` in the test server's channel so it
registers properly (the existing queue row is kept).

## Per-server match numbers (2026-09-11)

`match_id` is one AUTOINCREMENT sequence across every server, so a trial server's first
match would have been "#11". Migration 6 adds **`matches.match_number`** — counts from 1
per guild, unique on `(guild_id, match_number)`, backfilled in `match_id` order. Verified
against a copy of that morning's off-site snapshot: 10 matches, all Chris's server, numbers
1–10 = ids, so nothing visibly moves for him.

- **`match_id` stays the key.** Buttons' customIds, timers, `updateMatch`, foreign
  references and every service signature still take it. `match_number` is only ever read
  for display, and `Match` carries both.
- **Every human-facing surface shows `match_number`:** `#match-N`, `🔊 Ready Check #N`,
  the team VC names, the VS / result / gamble / history cards, the live-match and feed
  embeds, `/match list`, the split-report notice, the restart notice, the ban info field,
  the replay report. Log lines deliberately keep the DB id and now read `match id 47`
  rather than `Match #47`, so a log line can't be misread as a display number.
- **Admin commands take the number a human sees.** `/match report|cancel|cleanup` and
  `/replay check` have a `match:` option (was `match_id:`) resolved through
  `getMatchByNumber(guildId, n)` — scoped to the caller's guild, so an admin can no longer
  reach another server's match by guessing an id (they could before). A number that
  matches nothing gets "Match #N does not exist in this server." Option rename is picked
  up by the boot-time registration; no `npm run register` needed.
- `scripts/renderAll.ts` fixture carries `match_number`; all 13 cards byte-identical.
- Tests: `tests/matchNumber.test.ts` (per-guild counting, cancelled numbers not reused,
  guild-scoped lookup, unique index, migration backfill on a rolled-back file).

## Uptime heartbeat (2026-09-11)

The bot has no HTTP surface and the Pi has nothing inbound, so a monitor cannot poll it.
`src/services/heartbeat.ts` does the other direction: while `client.isReady()` (gateway
connected) it GETs `HEARTBEAT_URL` every `HEARTBEAT_INTERVAL_MINUTES` (default 5), first
ping immediately on ready. A dead Pi, hung process, crash loop or dropped gateway all look
the same to the monitor — the pings stop. Off unless `HEARTBEAT_URL` is set; a non-http(s)
value refuses to boot. Failures log once on change of state, not per tick.

**Live since 2026-09-11.** Chris created the Healthchecks.io check, set `HEARTBEAT_URL` on the Pi, and proved it: `systemctl stop` → Late → Down → alert → `start` → Up. Alerts go to **Telegram** (free, unlimited, phone push — he installed it for this) plus email as backstop. WhatsApp/SMS on Healthchecks are credit-limited; avoided. The steps, for a rebuild:
1. Healthchecks.io (free, 20 checks, has a Discord integration so the alert can land in
   his server) → New Check → period **5 min**, grace **5 min** → copy the ping URL.
2. On the Pi: add `HEARTBEAT_URL=https://hc-ping.com/<uuid>` to `~/discordBot/.env`,
   `sudo systemctl restart 6mans`, check `journalctl -u 6mans -n 20` for
   `Heartbeat: pinging hc-ping.com every 5 min`.
3. Prove it: `sudo systemctl stop 6mans`, wait ~10 min, expect the alert; `start` again.

UptimeRobot's heartbeat monitor or Better Stack work identically — anything that alerts
when a ping URL goes quiet. The log only ever prints the host, never the URL (it's a secret:
whoever has it can fake the bot being up).

## First bot trial run (2026-09-11, evening)

Chris ran the untested paths with the test bots. **Button-vote reporting, rematch starting
and Double or Nothing all worked.** Two findings, fixed on `main`:

- **Rematch left the channels named after game 1.** The card said Match #12 while the
  channel was still `#match-11` and the VCs `[Match #11]`. `startRematch` now renames the
  text channel (name + topic) and both VCs to the new number, fire-and-forget so Discord's
  two-renames-per-ten-minutes limit can never stall a rematch. Tested with a recording
  fake channel, and with a channel that cannot be renamed.
- **"PROMOTION ZONE" yellow pill → arrow.** Chris wanted a symbol, not a box. The result
  and gamble cards now draw a vector arrow (`src/ui/glyphs.ts`) right-aligned under the
  MMR delta: green up for the promotion zone, red down for the relegation zone.
  `getPromotionStatus` returns `direction`; `P.zone.promotion` default is now green
  (`#00e676`, same as a positive delta). Verified by rendering a lobby with players on
  both sides of Rank B's lines — `scripts/renderAll.ts`'s fixture never triggers a zone,
  so a byte-diff cannot see this change; look at the card.

## Slow cards on a slow evening (2026-09-11, 2v2 run)

Chris saw cards arrive slowly or not at all on the 2v2 run: the queue panel after his
join, and the ready-check card, while the mode-vote card was instant and the match card
normal. The pattern is avatars: the two slow cards draw **his** avatar cold, the vote card
draws none, and by the match card his avatar was cached. `loadImage(url)` downloaded from
Discord's CDN with **no timeout**, so a slow route from the Pi held every card that needed
a fresh avatar for as long as the CDN took; test bots skip the fetch, so bot-only cards
never showed it. The 15-minute cache TTL is why it came back.

Fixed on `main`:
- **4s deadline** on the whole avatar fetch (`AVATAR_FETCH_TIMEOUT_MS`); past it the card
  draws the player's initial. A miss is remembered for 60s so one bad CDN costs one wait,
  not one per card.
- **Prefetch on Join** (`prefetchAvatar`): the download starts when a player clicks Join,
  so pop-time cards find it cached.

If it happens again, `journalctl -u 6mans | grep "Avatar for user"` says which fetches
timed out. If nothing is logged and it is still slow, it is not avatars.

**It was not avatars.** After the fix no timeout was logged and it was still slow. The Pi
checked out healthy (one process, load 0.27, 3.6 GB free, Discord API 70–120 ms, a 200 KB
upload in 0.33 s), so the bot sends its cards in well under a second — what was slow was
Discord's CDN delivering images to Chris's client. Nothing in the bot for that. The avatar
deadline stays: it is right on its own terms.

What the log *did* show: `DiscordAPIError[10008] Unknown Message` on `vote_random`,
`teams_verify_yes` and `match_report_blue_18`. `autoDeleteReply` started its 6 s
countdown on **deferral**; in a bot lobby one click finalises the vote and runs the whole
next phase inline, which took > 6 s that evening, so the ephemeral was deleted before
`editReply`. Fixed: the countdown now starts when the reply is actually **sent**
(`interaction.replied`, set by editReply, not deferReply). The button catch block now
finishes a deferred reply with the error text instead of leaving "thinking…" stuck.
`tests/autoDelete.test.ts` pins it.

**Diagnostic one-liner for "everything is slow"** (procs, load, memory, Discord latency,
upload, recent warnings) — see the conversation of 2026-09-11 or rebuild from: `pgrep -af
"node.*dist"`, `uptime`, `free -m`, `curl -w %{time_total}` against
`discord.com/api/v10/gateway` with and without a 200 KB `-F` upload, `journalctl -u
6mans | grep -iE "warn|error|429"`. One process + fast curl = not the Pi.

## Double or Nothing wheel (2026-09-12, branch `gamble-wheel`)

The spin is now a real wheel. `src/services/wheelImage.ts` draws it -- eight slices
alternating blue and orange, gold rim and pointer, hub naming the match -- and renders the
spin as one animated GIF (360px, ~130 frames at 45 ms, lands at ~5.8 s then holds 15 s, ~1.2 MB, ~400 ms to render on
Windows) via `gifenc` (pure JS, so the Pi's `npm ci` needs no toolchain). The 50/50 is
decided *before* the GIF is drawn, so the wheel lands on the real answer; `landingAngleFor`
/ `segmentUnderPointer` are the only maths the outcome depends on and
`tests/wheelImage.test.ts` proves 500 seeds a colour land on the right slice. Every frame
is sharp and the frame count is sized from the angle so no step exceeds half a slice --
the first cut faked motion blur by smearing frames, which blended blue over orange into olive.

Flow after the last Agree: consensus card → GIF (one message edit) → wait one loop →
apply MMR → result PNG, whose header now carries the wheel frozen where the GIF stopped
(`generateGambleResultImage` takes the landing angle; roster block moved 20px down to
make room). If the GIF render throws, the gamble still resolves behind a plain
"Spinning…" line. The two emoji-ticker embeds (`buildGambleSpinningEmbed`) are gone.
No migration: `gamble_status` already stored `wheelWinner` / `resultType`.

Discord caveats accepted: it loops GIFs, so the wheel re-spins until the result card
replaces it (the landed frame holds 1.2 s per loop); a viewer with auto-play GIFs off sees
the resting wheel, then the result.

**Live since 2026-09-12** (a64b7a3): tested on the dev bot, then on the real server -- "looks perfect". Spin lengthened to ~5.8 s for suspense right after (three turns, 45 ms frames).

**Testing a branch without touching `main`** (first done for this one): a second Discord
application ("6mans Dev"), its own token, invited to the throwaway test server only
(`&permissions=288484368` on the invite URL, or just give its role Administrator -- the
README list of six permissions was short, and a bot cannot grant an overwrite it lacks), run
from the Windows checkout on the branch with `ENV_FILE=.env.dev npm run dev`
(`src/config.ts` reads `ENV_FILE`; `.env.*` is gitignored). `.env.dev` carries the dev
token/client id and `DB_PATH=data/dev.sqlite`, so it starts from an empty ladder: `/setup`
in the test server, then `/queue fill-bots`. Pick the dev bot's copy of each slash command
from the popup (Discord shows the bot avatar); buttons always go to the bot that posted the
card. Two fixes fell out of setting this up: the gamble consensus now counts humans only
(test bots never click, so a padded lobby could never spin -- the same fix every other
vote already had), and the consensus card's "All N must agree" counts the same way.

## Discord outage, 15 Sep 2026 16:41–16:55 SAST

A deploy restarted the bot in the middle of a Discord gateway outage (503 / 500 on login).
`client.login` failed → `process.exit(1)` → systemd restart → 361 processes in 14 minutes
until Discord recovered. Pi and network were fine. No issue was opened, because the exit
came before the report reached GitHub. Fixed:
- `src/services/login.ts` — `loginWithRetry`: backoff 5s→60s forever for passing failures;
  only `TokenInvalid` / `DisallowedIntents` / 401 are fatal. Warns per attempt, one
  `logger.error` after 5 min so the outage gets an issue.
- `flushErrorReports()` (errorReporter.ts) is awaited (max 5s) before every `process.exit`
  on the error paths, so the error that kills the process is the one that gets reported.

Diagnose a similar one with:
`journalctl -u 6mans --since "YYYY-MM-DD HH:MM" --until "…" | grep -E "restart counter|Logged in|Failed to log in"`.

## Next

0. ~~Register the queue channel to a division~~ — all five 3v3 divisions registered 2026-09-11. Policy calls done 2026-09-11.
0b. ~~`/replay check` against a real Discord upload~~ — done, worked (Chris, earlier session).
1. **Before the first outside trial:** (a) ~~per-server match numbers~~ — shipped 2026-09-11,
   see above. (b) Pick hosting: Oracle free tier, else Hetzner ~R80/mo; disclose it either
   way. (c) ~~Uptime monitor~~ — bot side shipped 2026-09-11; Chris creates the
   Healthchecks.io check and set `HEARTBEAT_URL` on the Pi — **done and proven 2026-09-11**.
2. Full achievements table — low value for a group of 6; the streak callouts already
   deliver most of it.
3. Webhooks — recommended **skip** until something actually consumes them.

## Multi-queue design (phase 5)

**A ladder is `(guild_id, team_size)`.** A queue channel is registered against exactly one
`(division, team_size)` pair in `guild_divisions`, and that row is the single source of
truth for both "how big is this queue" and "which ladder do its results count towards".
`getDivisionByChannel` is the resolver; `active_queues.team_size` and `matches.team_size`
cache the answer so nothing re-derives it mid-flow.

**Each size is a separate ladder** — independent MMR, W/L, division placement and
leaderboard. A 3v3 win does not touch your 2v2 rating. One season spans all three and
resets them together.

Migration 4 split `players` into identity (`players`) and per-size stats
(`player_ladders`). Keying the old combined table on `team_size` would have given each
player three copies of their username, and the rename path updates one row — so a renamed
player would keep the stale name on the sizes they had not played since.

Setup for a new size: `/queue panel size:4v4 division:A` in the channel. Most read
commands take an optional `size:`, defaulting to 3v3.

## `/setup` — one-command onboarding (2026-09-11, late)

`src/services/setupService.ts` + `src/commands/setup.ts`. For a new server: per chosen
division, find-or-create a category named after it (`Rank C`), a text channel
`rank-c-3v3` inside it, register it as the queue channel and post the panel (via the new
shared `registerQueueChannel` in `queuePanel.ts`, which `/queue panel` now uses too);
optionally a role per division stored on `guild_divisions.role_id` with the category
locked to that role; optionally the public `#active-matches` feed. Presets: `one` (C only
— everyone together, default), `three` (C/B/A), `all`. Idempotent: everything is looked
up by name or by the already-registered channel id first, so a re-run repairs gaps and
creates nothing that exists. Gated on Manage Server; checks the bot's own permissions
first and names the missing ones. `tests/setup.test.ts` (fake guild records creates).

**Ladder naming (same night, after Vanilla's server joined):** a one-ladder server saw "Rank C"
everywhere, which means nothing without a B. `/setup name:` (default `6mans`) renames division C on
every size; a re-run renames the category/channel/role it made earlier instead of duplicating
them (a channel an admin renamed is left alone). The cards took "Rank C" from a hard-coded
table -- `src/services/divisionNames.ts` now carries the server's names in the same request
context as the palette (`withGuildTheme` sets both) and `getDivisionTier` reads them; cache is
reloaded in place so the panel posted inside the renaming request already shows the new name.
`/division configure name:` renames any division. Third real server: **Vanilla's**
(`1348387644693938370`), joined 21:34 SAST 2026-09-11.

**Run on the throwaway test server 2026-09-11 (`divisions:three roles:true`), twice: built
correctly, second run created nothing.** Chris asked for highest rank on top and
`━━━━━  Rank S  ━━━━━` category names (6547fb7); confirmed right after a re-run.

Chris's own server was set up by hand before this existed (all five 3v3 divisions, see
"Live setup"); `/setup` there would find everything by name except the queue channels,
which it keeps because they are already registered. No need to run it.

## Where `feature_plan1.md` is wrong

- **Features 5 (Match Duration) and 6 (Ban/Cooldown) were already built** in the initial
  commit. The plan lists them as to-do.
- Its **Season design** (compress MMR toward 1000 by ×0.5) contradicts the agreed monthly
  **hard reset to each division's default**. Divisions each have their own default, so
  compressing toward one number collapses the ladder.
- Its **achievement keys** are MMR-threshold based (`rank_b` at 1200 MMR), which stops
  making sense now that rank is stored state rather than derived from MMR.
- Its **Best-of-3** contradicts the agreed *BO5 lobby, winner-only reporting* — one report
  at the end, no per-game score. Rematch was built as "same teams, new match, series
  counter", not a BO3 scoring system.

## Gotchas found in the heartbeat outage (2026-11-03)

- **`client.isReady()` latches false after a failed login.** `client.login()` calls
  `client.destroy()` when it throws, which sets `ws.destroyed = true` for good;
  `loginWithRetry` then logs in on the same client and everything works except
  `isReady()`. The Pi boots before WiFi is up, so this hit nearly every boot: from 09-18
  the heartbeat skipped every ping in silence and Healthchecks showed the bot down for six
  weeks while it was online (four real power cuts in Oct went unalerted). The heartbeat
  now reads shard status via `gatewayConnected`, and logs when it pauses. **Never use
  `isReady()` for liveness.**

## Gotchas found in the first live session

- **SQLite `CURRENT_TIMESTAMP` is UTC with no zone marker, and `new Date()` reads it as
  local.** `"2026-08-09 09:03:13"` is not ISO 8601, so V8 falls back to local-time
  parsing — on UTC+2 every `created_at` came back two hours early. That made
  `sweepStaleMatches` see a brand-new match as 121 minutes old and auto-cancel it
  mid-vote. **Always use `parseDbTimestamp` from `src/utils/time.ts`**, never a bare
  `new Date(row.created_at)`. Note the columns hold two shapes: `created_at` is bare,
  while `started_at` / `completed_at` come from `toISOString()` and carry a `Z`.
- **The vote thresholds are four separate gates** — mode, captain verify, team verify,
  report. Multi-queue generalised two and missed two, which sat on a literal `4`. There's
  a tripwire test in `multiQueue.test.ts` now, but it is a regex, not a proof.
- `votesRequiredFor` caps the threshold at the number of *humans* in the lobby, so a
  bot-padded test lobby needs only 1 vote. Handy for testing, and worth remembering
  before concluding a threshold is broken.

## Gotchas found in the multi-queue session

- **A migration must be a frozen snapshot.** Migration 2 called the shared
  `seedGuildDefaults`, whose shape changed in migration 4 — it now writes a `team_size`
  column that does not exist yet at version 2. Migration 2 has its own private
  `seedGuildDefaultsV2` now. Watch for this whenever a migration calls a shared helper.
- **The captains draft image was clipping.** Not a multi-queue bug — the available pool
  holds 4 cards at pick 1 even at 3v3, which needed 455px on a 420px canvas. Found by
  rendering, not by tests. Heights are computed from roster length now.
- **Narrow canvases collide with their own headers.** At 2v2 the grid is only 620px, which
  is narrower than the title plus status badge. The queue panel and ready check now
  measure header text and widen the canvas when the header is the widest element.
- The queue panel at 3v3 is deliberately **pixel-identical** to before: `80 + n·240 +
  (n−1)·20` lands on exactly 840px at n=3.
- `feature_plan1.md` is untracked on purpose and `git add -A` keeps trying to commit it.
  Untrack it (`git rm --cached`) if it sneaks in.

## Gotchas found in earlier sessions

- **Never re-derive rank from MMR.** `getRankTier(mmr)` is gone; use
  `getDivisionTier(player.division)`. Rank only changes at a season reset.
- **The canvas has no host fonts to rely on.** Fonts are bundled and registered in
  `src/utils/fonts.ts`; all 92 font strings use the exported `FONT_STACK`. A comma stack
  falls back per glyph (letters from Inter, emoji from Noto) — verified by rendering.
- **Verify image changes by rendering and looking.** Two real bugs this session (wrong
  streak value, tofu emoji) passed the tests and were only caught by looking at the PNG.
  Render to a temp DB via `DB_PATH=... npx ts-node`, never against `data/6mans.sqlite`.
- **Match/queue/player queries are guild-scoped now.** A bare `discord_id` no longer
  identifies a row.
- **`mutateMatchReportStatus` is the way to write votes** — it does read+write in one
  transaction. Don't hand-roll a read-modify-write.
- Test DB cleanup must delete `season_snapshots` before `seasons` (foreign key).
- Two bot processes on one token cause `DiscordAPIError[10062]`, which looks exactly like
  a performance bug and is not one.
- **A fake-client pop clobbers the popping queue's row.** `startReadyCheckPhase` with
  `fakeClient` takes the no-guild fallback, which `saveQueue`s the *lobby* over the source
  row (state VOTING) before `startVotingPhase` throws at `createMatchChannels`. Assert on
  the match row and the *other* queues after a fake pop, never on the popping queue's row.
- **Cancel the failed match before requeueing its players.** `returnPlayersToQueue` re-pops
  through `startReadyCheckPhase`, whose busy-player backstop drops anyone still in a live
  match -- so a READY_CHECK match that is not yet CANCELLED drops the whole lobby.
