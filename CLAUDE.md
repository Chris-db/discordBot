# 6mans bot

Rocket League pickup-game ("6mans") Discord bot: TypeScript, discord.js v14, SQLite
(`better-sqlite3`), canvas image cards. It runs live on Chris's Raspberry Pi and serves
several Discord servers.

## Read first

- `PROGRESS.md`: status and the **Backlog** (what is open, deferred or rejected).
- `docs/ARCHITECTURE.md`: code map, the match flow, the data model, **settled design
  decisions** (don't reverse one without asking Chris), and **Rules**, each of which cost a
  real bug once.
- `docs/OPERATIONS.md`: deploys, logs, backups, the dev bot, diagnosing.

## Commands

```bash
npm test                 # vitest, whole suite (about 10 s)
npx vitest run tests/<file>.test.ts
npx tsc --noEmit         # typecheck
npm run build
```

Render every image card after touching image code, against a throwaway DB, and look at
the output:

```bash
DB_PATH=<temp>/x.sqlite npx ts-node scripts/renderAll.ts <out dir>
```

## Working here

- **Merging to `main` deploys to the live bot within 15 minutes** (the Pi's deploy timer
  tests, builds and restarts). Keep `main` shippable: work on a branch, open a PR, let CI
  pass.
- **Never run the production bot on this PC** while the Pi's copy is up. Use the dev bot
  (`ENV_FILE=.env.dev npm run dev`, see OPERATIONS.md).
- **Never touch `data/6mans.sqlite`** from tests or scripts; use `DB_PATH` to a temp file.
- Every time from the database goes through `parseDbTimestamp`, every query is
  guild-scoped, every vote write goes through `mutateMatchReportStatus`, every colour comes
  from `P` and every font string uses `FONT_STACK`. The reasons are in ARCHITECTURE.md
  ("Rules").
- Players see `match_number`; code and logs use `match_id`.
- Match the code's style: comments that say *why*, written as plain sentences; small
  functions; no new dependency without a good reason.

## Keeping the docs true

- Finished or dropped a Backlog item? Update it in `PROGRESS.md` in the same PR.
- Found a new trap? Add it to "Rules" in `docs/ARCHITECTURE.md`.
- Changed how something works? Fix the doc that describes it in the same PR.
- `docs/history/` is a record. Add to the build log; don't rewrite it.
