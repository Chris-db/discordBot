# 6mans Bot — Build Progress

Tracker for a multi-session build. Update this before ending a session.

Last updated: 2026-08-08 (multi-queue session)

---

## Read first

- `TESTING.md` — the ordered checklist for the first live session, and what should happen
  at each step. Nothing here has ever run against Discord.

- `AUDIT.md` — the full codebase audit. Still the source of truth for what's wrong.
- `feature_plan1.md` — **treat as a menu of ideas, not a spec.** It is stale and partly
  contradicts agreed design (see "Where the plan is wrong" below).
- Project memory (`discord-6mans-bot`) — the agreed design decisions.

## Status: nothing is deployed

**The bot Chris runs in his terminal is on `ebeb413` (the initial commit).** Every branch
below is unmerged and has never run in Discord. Chris has said he does not want to test
incrementally — the plan is to build the batch, then test it all at once.

Note: local `main` has since been fast-forwarded to `818432c` (5 ahead of `origin/main`),
even though the running bot is still on the initial commit.

He has also said **he does not care about the existing data** and would prefer to start
fresh, so the migration's legacy-upgrade path is a nice-to-have for onboarding a future
second server, not a constraint on his own database.

## Branch stack

Each branches off the previous. None merged to `main`.

```
main (ebeb413)
└── phase-1-stability          P0 fixes + nightly backups
    └── fix/voting-and-ban-p1  P1-11, P1-12, P1-13 + ban removes from queue
        └── phase-2-migration  guild_id, rank divisions, seasons, /division, /season
            └── feature/rematch        rematch + requeue + dynamic updateMatch
                └── feature/streak-callouts   streak badges + bundled fonts
                    └── feature/multi-queue   2v2 / 3v3 / 4v4 + per-size ladders
```

Tests: **168 passing**. `npx tsc --noEmit` clean. `npm run build` clean.

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

## Going live

Merge down to `main`, `npm run register` (the slash commands have new options), restart,
and play a real session.

Migration 4 has been dry-run against a copy of the live `data/6mans.sqlite`: all six
players keep their exact MMR on the 3v3 ladder, divisions backfill from the legacy bands,
the existing match and queue rows stamp as 3v3, and `foreign_key_check` /
`integrity_check` come back clean. Existing 3v3 play is unaffected — a 2v2 or 4v4 channel
only exists once someone runs `/queue panel size:`.

Worth exercising in Discord, since none of it has met a real Discord API yet: a 4v4
captains draft (the serpentine order and the taller draft card), the `userLimit` on team
VCs at 2v2 and 4v4, and a report vote at 4v4 needing 5 of 8.

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
