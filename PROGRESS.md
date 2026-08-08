# 6mans Bot — Build Progress

Tracker for a multi-session build. Update this before ending a session.

Last updated: 2026-08-08

---

## Read first

- `AUDIT.md` — the full codebase audit. Still the source of truth for what's wrong.
- `feature_plan1.md` — **treat as a menu of ideas, not a spec.** It is stale and partly
  contradicts agreed design (see "Where the plan is wrong" below).
- Project memory (`discord-6mans-bot`) — the agreed design decisions.

## Status: nothing is deployed

**The bot Chris runs in his terminal is on `ebeb413` (the initial commit).** Every branch
below is unmerged and has never run in Discord. Chris has said he does not want to test
incrementally — the plan is to build the batch, then test it all at once.

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
```

Tests: **136 passing**. `npx tsc --noEmit` clean. `npm run build` clean.

## Done

| Phase | What |
|---|---|
| 1 | Six P0 bugs (ordering, queue deletion, vote races, ready-check re-pop, stale matches, restart recovery) + nightly SQLite backups |
| P1s | Balanced re-roll stays balanced; mode-vote ties are a coin flip; `/ban 30m` = minutes; banning removes from waiting queues |
| 2 | Migration runner (`schema_migrations`, transactional, fatal on error); `players` keyed on `(guild_id, discord_id)`; stored rank divisions; seasons with hard reset + promotion/relegation; `/division`, `/season`; `getRankTier` deleted |
| 3 | Rematch (same teams, new match row, `series_id`), Back-to-Queue button, cancellable channel teardown, dynamic `updateMatch` |
| 4 | Streak badges on result card + queue panel; promotion-zone moments; **Inter + Noto Color Emoji bundled** in `assets/fonts` |

## Next

1. **Multi-queue (2v2 / 4v4)** — the last big one. `team_size` on `active_queues`, kill every
   hardcoded 6, generalise the captains pick order (serpentine `B,O,O,B,B,O` for 4v4),
   dynamic image grids. Real driver: the bot only works at *exactly* 6, so 8 people means
   2 sit out.
2. `/history` series score (rematch series is tracked but not surfaced there).
3. Full achievements table — low value for a group of 6; the streak callouts already
   deliver most of it.
4. Webhooks — recommended **skip** until something actually consumes them.

Then: merge down to `main`, `npm run register`, restart, and play a real session.

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

## Gotchas found this session

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
