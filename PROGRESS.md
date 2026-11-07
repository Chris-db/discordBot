# 6mans Bot — Progress

Where the bot stands and what is left to do. Update this at the end of a session that
changes either; put the story of the session in `docs/history/BUILD-LOG.md`.

Last updated: 2026-11-04 (banter added)

| For | Read |
|---|---|
| How the code works, settled design, rules | `docs/ARCHITECTURE.md` |
| Deploying, logs, backups, the dev bot, diagnosing | `docs/OPERATIONS.md` |
| Checklist for a live test run | `docs/TESTING.md` |
| How it got here | `docs/history/` |

## Status

Live on the Pi since 2026-09-10 and auto-deploying from `main`. Every core flow has been
played in Discord: queue, ready check, all three modes, report, rematch, Back to Queue,
Gamble (with the wheel and its "Tap to spin" cover), `/replay check`, `/setup`, themes, and
a second division channel. Tests: 442 passing; typecheck and build clean.

**Servers:** Chris's own; Vanilla's (`1348387644693938370`, joined 2026-09-11); a throwaway
test server where the dev bot lives.

**Chris's server** has all five 3v3 divisions, each in its own category, set up by hand
before `/setup` existed (running `/setup` there would find everything and change nothing):

| Division | Queue channel id |
|---|---|
| S | `1532714997568897024` (the original queue channel) |
| X | `1547878777936154655` |
| A | `1547878982345695292` |
| B | `1547879043058114560` |
| C | `1547879120459931679` |

The test bots sit in C; `/queue fill-bots` bypasses the division gate on purpose. Since
2026-11-07 it runs only in servers listed in `TEST_GUILD_IDS`. That day five bots were
removed from "6mans server" (`1567470007531737189`), a live server; they had played one
match, #35, which stays as history.

## Backlog

Built 2026-11-03 from the original audit, the retired `feature_plan1.md` and the old Next
list, each item checked against the code.

**Open**
- **2v2 / 4v4 live run.** Never played against Discord; no channel is registered to a size.
- **AFK ping at T-20s** in the ready check, before it fails.
- **Help button on the queue panel.** `/help` exists only as a command.
- **Image smoke tests for every card.** Only the wheel, profile and palette render in tests.
- **Pin Node 24** in `package.json` `engines`. CI pins it; nothing else does.
- **Remove banter** once the joke gets old. `src/services/banter.ts` says how.
- **Code readability**, one small PR each, behaviour unchanged: split `queries.ts`
  (1,249 lines) and `votingService.ts` (1,027); typed DB rows instead of `row: any`
  (`parseQueueRow`, `parseMatchRow`); a shared drawing kit for the `*Image.ts` cards.

**Deferred** (ask Chris before building)
- Ready-check failure pulls the next queued player in, instead of sending the lobby back.
- "I'm here" button as an alternative to joining the VC.
- Party/duo; MMR preview on the teams vote; queue-pop estimate (needs queue-to-pop history
  the schema does not keep).
- Full achievements table -- the streak callouts deliver most of it. The old plan's
  MMR-threshold keys are wrong now that rank is stored state.
- Webhooks -- only once something consumes them.
- Stricter `tsconfig` (`noUncheckedIndexedAccess`, `noUnusedLocals`): worth it, but expect a
  long list of fixes the first time.
- Only if someone complains: panel re-post on chat (1200 ms debounce), the
  `autoDeleteReply` timers, leaderboard paging on an ephemeral reply with images.

**Rejected**
- Queue state-machine extraction and a `match_players` table -- restart recovery and vote
  races were fixed another way (sweeps, `mutateMatchReportStatus`).
- `loadConfig()` instead of import-time config -- `vitest.config.mts` covers the test need.

Already done, for the record: colour-blind division colours (`mmrService.ts`), draft
auto-pick (`DRAFT_PICK_TIMEOUT_SECONDS`), split-report notice, Requeue button, seasons,
rematch, multi-queue, streaks, match duration, bans, the wheel GIF cover frame.
