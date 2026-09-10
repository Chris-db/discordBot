# 6mans Bot — Build Progress

Tracker for a multi-session build. Update this before ending a session.

Last updated: 2026-08-09 (first live session)

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

**Ship loop:** `npm test` → commit → `git push` (Windows), then on the Pi:

```
ssh chris@pi5.local
cd ~/discordBot
git pull
npm ci
npm run build
sudo systemctl restart 6mans
systemctl status 6mans
```

`npm ci` only matters when `package.json` changed, but it is harmless otherwise.
`npm run register` is only needed when a slash command is added, renamed or gets new
options. Read logs with `journalctl -u 6mans -f`.

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

## Still unexercised in Discord

Everything else worked, but these have never been run against the real API:

- Reporting by **button vote** (matches #5 and #7 were force-reported via `/match report`).
- **2v2 and 4v4** in any form — no channel is registered to a size yet.
- Double or Nothing.
- Rematch actually starting (the decline path was tested).

Tests: **190 passing**. `npx tsc --noEmit` clean. `npm run build` clean.

## Done

| Phase | What |
|---|---|
| 1 | Six P0 bugs (ordering, queue deletion, vote races, ready-check re-pop, stale matches, restart recovery) + nightly SQLite backups |
| P1s | Balanced re-roll stays balanced; mode-vote ties are a coin flip; `/ban 30m` = minutes; banning removes from waiting queues |
| 2 | Migration runner (`schema_migrations`, transactional, fatal on error); `players` keyed on `(guild_id, discord_id)`; stored rank divisions; seasons with hard reset + promotion/relegation; `/division`, `/season`; `getRankTier` deleted |
| 3 | Rematch (same teams, new match row, `series_id`), Back-to-Queue button, cancellable channel teardown, dynamic `updateMatch` |
| 4 | Streak badges on result card + queue panel; promotion-zone moments; **Inter + Noto Color Emoji bundled** in `assets/fonts` |
| 5 | Multi-queue at 2v2 / 3v3 / 4v4, with each size a fully separate ladder |

## Next

1. `/history` series score (rematch series is tracked but not surfaced there).
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

## Setup still outstanding

**No queue channel is registered to a division**, so `guild_divisions.queue_channel_id`
is empty for all fifteen rows and every match stamps `division = NULL`. Everything
defaults to 3v3 and plays fine, but rank divisions, promotion/relegation and
per-division leaderboards stay inert until someone runs `/queue panel division:C` (or
`/division configure`) in the queue channel.

A 2v2 or 4v4 channel only exists once someone runs `/queue panel size:`.

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
