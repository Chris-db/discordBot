# Architecture

How the bot is put together, the design calls that are settled, and the rules that keep it
working. Read this before changing anything non-trivial. For running it on the Pi see
`OPERATIONS.md`; for the session-by-session history see `history/BUILD-LOG.md`.

## What it is

A Discord bot for Rocket League pickup games ("6mans"). Players click **Join** on a queue
panel; when the queue fills the bot runs a ready check, a team-mode vote, makes a private
match channel and team voice channels, hands out the RL lobby name and password, collects
the result by button vote, and updates each player's MMR. One bot serves several Discord
servers (guilds); everything is scoped by `guild_id`.

Stack: Node 24, TypeScript, discord.js v14, SQLite through `better-sqlite3` (synchronous,
WAL), `@napi-rs/canvas` for the image cards, `gifenc` for the wheel GIF, `vitest` for tests.

## Code map

```
src/
  index.ts              boot: config check, fonts, migrations, login, event wiring, sweeps
  config.ts             .env → typed AppConfig; validateConfig() refuses bad values at boot
  commands/             one file per slash command, each exports { data, execute }
  handlers/             commandHandler (routes slash commands), interactionHandler (buttons, menus)
  database/
    db.ts               the better-sqlite3 handle
    migrations.ts       numbered, transactional migrations; fatal on error
    queries.ts          every SQL query and the row types (Player, Match, ActiveQueue, …)
  services/             the behaviour (see the flow below) plus one *Image.ts per card
  ui/                   buttons, embeds, select menus, palette (colours), glyphs
  utils/                logger, fonts, time parsing, avatar cache, replay header parser
tests/                  vitest; one file per area, fake Discord clients where needed
scripts/                renderAll.ts (render every card), Pi deploy + backup scripts
```

`services/queueService.ts` is a barrel that re-exports the queue modules (`queuePanel`,
`readyCheckService`, `votingService`, `queueTimeout`), so most callers import from there.

## A match, start to finish

| Step | Where | What happens |
|---|---|---|
| Join | `queuePanel.ts` | Join/Leave buttons on the panel. Join is gated by division and by bans/AFK cooldowns. The first player into an empty queue pings the division role. The panel re-posts itself to the bottom when people chat. |
| Pop | `queuePanel.ts` → `readyCheckService.ts` | A full queue becomes a lobby. Its roster is stripped from every other waiting queue, and anyone already in a live match is never popped. |
| Ready check | `readyCheckService.ts` | A `🔊 Ready Check #N` VC and a private `#match-N` channel. Players are ready by joining the VC. Not-ready fails it early; missing it gives a 5-minute cooldown (`AFK_COOLDOWN_MINUTES`). The others go to the front of the queue. |
| Mode vote | `votingService.ts` | Captains / Balanced / Random. Ties are a coin flip. |
| Teams | `votingService.ts`, `draftService.ts` | Captains: a draft by select menu, pick order shown on the card, auto-pick after `DRAFT_PICK_TIMEOUT_SECONDS`. Balanced/Random: a teams vote with at most three re-rolls, then the next split is final. |
| Match | `matchService.startNewMatch` | Team VCs sized to the team, players moved in, lobby name and password posted on separate lines. |
| Report | `matchService.ts`, `gameRules.ts` | Players vote the winner. A split report (neither side can reach the majority) posts a notice pointing at `/match report`. |
| Complete | `matchService.completeMatch`, `mmrService.ts` | Elo deltas, streaks, the result card, the public feed card. |
| After | `rematchService.ts`, `gambleService.ts` | For 3 minutes (`REMATCH_WINDOW_MS`): Run it back (same teams, new match, same `series_id`), Back to Queue, or Gamble (unanimous agree → wheel spin → MMR doubled or flipped). |
| Teardown | `channelService.ts` | Match channel and VCs deleted once the window closes. |

Every vote card shows a live `<t:…:R>` deadline (`VOTE_TIMEOUT_SECONDS`) and says what
silence does. Finalizers run under a per-channel lock, so a timer and a click cannot
resolve the same vote twice.

**Background loops** (`queueTimeout.ts` and friends): queue timeout, stale-match sweep
(`MATCH_TIMEOUT_HOURS`), orphaned match channels, `recoverStuckQueues` at boot (a restart
cancels in-flight setups and posts a "re-queue to play" notice), `sweepStrayQueuePanels`,
daily SQLite backups (`backupService.ts`), the uptime heartbeat (`heartbeat.ts`), and the
error reporter (`errorReporter.ts`).

## Data model

- **A ladder is `(guild_id, team_size)`.** 2v2, 3v3 and 4v4 are fully separate: their own
  MMR, W/L, division and leaderboard. `players` holds identity; `player_ladders` holds the
  per-size stats. Read commands take an optional `size:`, defaulting to 3v3.
- **A queue channel is registered** in `guild_divisions` against exactly one
  `(division, team_size)`. That row is the single truth for "this channel has a panel",
  "how big is this queue" and "which ladder do results count towards".
  `getDivisionByChannel` resolves it; `active_queues.team_size` and `matches.team_size`
  cache the answer so nothing re-derives it mid-flow.
- **Divisions** C / B / A / X / S, defaults 1000 / 1300 / 1500 / 1700 / 1900 MMR, each with
  promote and relegate lines. A server can rename any division (`/setup name:`,
  `/division configure name:`); `divisionNames.ts` carries the names per request.
- **`match_id` vs `match_number`.** `match_id` is the global key used by buttons, timers
  and every service. `match_number` counts from 1 per guild and is the only number a human
  ever sees (channel names, cards, admin command options). Log lines say `match id 47`.
- **Seasons**: `/season end` (manual, refuses while anything is live) snapshots standings,
  promotes/relegates, and resets every MMR to its division's default.
- **Themes**: `guild_themes` stores only a server's colour overrides. `P` (`ui/palette.ts`)
  is an `AsyncLocalStorage`-backed proxy; every interaction runs inside
  `withGuildTheme(guildId, …)`, which sets both the palette and the division names.
  Discord embed side-bars are deliberately not themed.
- **Migrations** live in `database/migrations.ts`, one transaction each, recorded in
  `schema_migrations`, fatal on error.

## Settled design decisions

Agreed with Chris. Don't reverse one without asking him first.

- **One division per player per size.** Join refuses a channel of another division;
  `/queue add` by an admin overrides.
- **Rank is stored state, not derived from MMR.** It changes only at a season reset or by
  `/division place`.
- **Seasons are a hard reset to each division's default**, run by hand. Not a compression
  toward one number, which would collapse the ladder.
- **A BO5 lobby with winner-only reporting**: one report at the end, no per-game score.
  Rematch is "same teams, new match, series counter", not a best-of-N scorer.
- **`/match` is the admin surface.** Discord cannot hide a button per viewer, so there is
  no mod-override button; `/match` is hidden by `setDefaultMemberPermissions`.
- **The queue panel message has no text**: the image says it all.
- **The Gamble outcome is decided before the wheel is drawn.** The GIF is a recording, and
  the result card is a separate message so nobody depends on the animation.

## Rules

Each of these cost a real bug once.

**Time and data**
- **Never `new Date(row.created_at)`.** SQLite's `CURRENT_TIMESTAMP` is UTC with no zone,
  and V8 reads it as local time. Use `parseDbTimestamp` from `utils/time.ts`.
  (`created_at` is bare; `started_at` / `completed_at` carry a `Z`.)
- **Queries are guild-scoped.** A bare `discord_id` does not identify a row.
- **Write votes with `mutateMatchReportStatus`**, which reads and writes in one
  transaction. Never hand-roll a read-modify-write.
- **Never re-derive rank from MMR.** Use `getDivisionTier(player.division)`.
- **A migration is a frozen snapshot.** Never call a shared helper whose shape can change
  later (migration 2 has its own `seedGuildDefaultsV2` for this reason).

**Votes and flow**
- **There are four vote thresholds**: mode, captain verify, team verify, report. Changing
  how one is counted means checking all four. `votesRequiredFor` caps a threshold at the
  number of humans, so a bot-padded test lobby needs only one vote.
- **Cancel a failed match before requeueing its players.** `returnPlayersToQueue` re-pops
  through `startReadyCheckPhase`, which drops anyone still in a live match.

**Discord**
- **Never use `client.isReady()` for liveness.** It latches false after a failed login
  that was retried. The heartbeat reads shard status (`gatewayConnected`).
- **Two bot processes on one token** cause `DiscordAPIError[10062] Unknown interaction`,
  which looks like a performance bug and is not one.
- Ephemeral replies use `flags: MessageFlags.Ephemeral`, not `ephemeral: true`.

**Images**
- **Render and look at every image change.** Wrong streak values, tofu emoji and a
  clipped draft card all passed the tests. `scripts/renderAll.ts` renders every card with
  fixed data; always against a temp DB (`DB_PATH=...`), never `data/6mans.sqlite`.
- **Every font string uses `FONT_STACK`** (`utils/fonts.ts`). The fonts (Inter + Noto
  Color Emoji) are bundled; the host has none.
- **Colours come from `P`**, never a literal, so themes reach them.
- Canvas widths are computed from the roster and the header text; narrow 2v2 canvases
  used to clip their own titles.

**Tests**
- Test DB cleanup deletes `season_snapshots` before `seasons` (foreign key).
- After a fake-client pop, assert on the match row and the *other* queues, never the
  popping queue's row: the no-guild fallback overwrites it.

## Replay reader

`/replay check` parses only the replay **header** (`utils/replayHeader.ts`, no library)
and never changes a result. Format facts, verified against 260 real replays:

- The header carries `Team0Score`, `Team1Score`, `WinningTeam`, `MatchStartEpoch`,
  `MatchType`, `Date` and `PlayerStats`. A property at its default is **omitted** (a
  missing `Team0Score` means 0).
- The score decides; `WinningTeam` (newer replays only) settles a level score, and its
  presence with value 0 means Blue.
- `ByteProperty` with enum name `None` is followed by **one raw byte**, not a string.
- Epic ids live in `PlayerID.EpicAccountId`, Steam/PSN in `OnlineID`.
- Rocket League has no replay auto-save and no result log, so automatic reporting would
  need a program on a player's PC. Parked.
