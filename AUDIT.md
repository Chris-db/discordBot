# 6mans Bot — Full Audit

Date: 2026-08-03 · Reviewed at commit `ebeb413` (initial commit) · 43 source files, ~6.5k lines

Scope: every file in `src/` and `tests/`. Findings are ranked by how likely they are to
bite you in a real lobby with 6 humans, not by how interesting they are.

Legend: **P0** = will break a live session · **P1** = will annoy people every night ·
**P2** = polish / future-proofing.

---

## Part 1 — Correctness bugs

### P0-1. `getPlayersByIds()` silently reorders players → the crown lands on the wrong captain

`src/database/queries.ts:125`

```sql
SELECT * FROM players WHERE discord_id IN (?,?,?)
```

SQL `IN` has no ordering guarantee. SQLite satisfies this from the `discord_id` primary-key
index, so rows come back **sorted by Discord ID**, not in the order you asked for. Verified:

```
requested: [ 'ccc', 'aaa', 'bbb' ]
returned : [ 'aaa', 'bbb', 'ccc' ]
```

Everything downstream assumes list order is meaningful:

| Caller | What breaks |
| :--- | :--- |
| `embeds.ts:85` `buildCaptainsDraftEmbed` | `idx === 0 ? '👑'` — the crown is drawn on whoever has the smallest Discord ID (i.e. the oldest account), **not** the captain |
| `queueImage.ts:69` `players[i]` | Queue slots #1–#6 are in random-looking order; the person who joined first isn't slot 1 |
| `readyCheckImage`, `matchImage`, `resultImage`, `draftImage` | Same — rosters render in ID order |
| `queue status` / `buildQueuePanelEmbed` | "**1.** @x" numbering is meaningless |

**Fix:** make `getPlayersByIds` order-preserving:

```ts
export function getPlayersByIds(discordIds: string[]): Player[] {
  if (discordIds.length === 0) return [];
  const placeholders = discordIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM players WHERE discord_id IN (${placeholders})`)
    .all(...discordIds) as Player[];
  const byId = new Map(rows.map(p => [p.discord_id, p]));
  return discordIds.map(id => byId.get(id)).filter(Boolean) as Player[];
}
```

This is a one-function fix that quietly repairs six different screens. Do it first.

> Second-order note: this function also **drops** any id that has no `players` row, so
> `blueTeam.length` can silently become 2. Worth an explicit log if that ever happens.

---

### P0-2. Cancelling a match in READY_CHECK deletes the whole rank queue

`src/services/matchService.ts:438`

```ts
if (match.channel_id && match.channel_id !== match.queue_channel_id) {
  deleteQueue(match.channel_id);
}
```

`queue_channel_id` is only written in `startVotingPhase` (`votingService.ts:138`). A match
created by `startReadyCheckPhase` has `channel_id` = **the rank queue channel** and
`queue_channel_id` = `NULL`. So the two differ and the guard passes. Verified:

```
channel_id      : RANK_QUEUE_CHANNEL
queue_channel_id: undefined
=> would deleteQueue( RANK_QUEUE_CHANNEL )? true
```

Effect: an admin running `/match cancel <id>` (or clicking Force Cancel) on a match still in
ready check **deletes the `active_queues` row for the main queue channel** — panel message id,
everyone waiting, all gone. The panel then re-creates itself empty on next refresh, which
makes it look like "the bot randomly cleared the queue".

Same hazard in the `forcePopQueue` path, which also never sets `queue_channel_id`.

**Fix:** set `queue_channel_id` at match creation time in `startReadyCheckPhase` and
`forcePopQueue`, and tighten the guard to only delete *temporary* match queues:

```ts
if (match.text_channel_id) deleteQueue(match.text_channel_id);
// never delete match.channel_id — that's the persistent rank queue
```

---

### P0-3. Concurrent button clicks lose votes (read-modify-write race)

`matchService.ts:222-238`, `gambleService.ts:174`, `votingService.ts:386`

Every vote handler does: read the row → mutate a JSON blob in JS → write the whole row back.
Two players clicking within the same tick both read the *pre-vote* state, and the second write
clobbers the first. Verified:

```
p1 votes Blue, p2 votes Blue (interleaved)
final blueVotes: [ 'p2' ]      // p1's vote vanished
```

With 6 people mashing "Report Blue Win" the instant a game ends, this is not theoretical —
it's the most likely explanation for "we all reported but it didn't complete".

**Fix:** wrap each vote in `db.transaction()` and re-read inside the transaction, exactly like
`handleJoinQueue` already does (`queuePanel.ts:208` — that one is correct; copy its shape).
`better-sqlite3` is synchronous, so a transaction genuinely serialises here.

---

### P0-4. Ready-check re-pop wipes the players waiting behind it

`src/services/readyCheckService.ts:286-316`

When ready check fails and there are ≥6 players left over, the code:

1. saves `rankQueue.player_ids = remainingIds` (the overflow players), then
2. calls `startReadyCheckPhase(client, channelId, guildId, popQueue)` where
   `popQueue.channel_id === channelId`.

Inside `startReadyCheckPhase` (line 161-167):

```ts
queue.player_ids = [];
...
saveQueue(queue);        // queue.channel_id === channelId → overwrites step 1
```

The overflow players are silently deleted from the queue. They'll be sitting there watching
the panel drop them for no visible reason.

**Fix:** don't reuse `startReadyCheckPhase`'s "reset the source queue" behaviour for a
synthetic queue. Either pass the 6 ids explicitly and have the function not touch the DB row
it didn't read, or re-save `rankQueue` *after* the recursive call.

---

### P0-5. No timeout on an IN_PROGRESS match → players get permanently locked out

There is no sweeper for matches stuck in `IN_PROGRESS`. `handleJoinQueue` blocks anyone with an
active match (`queuePanel.ts:182`), and the only escape is the text channel being deleted —
which only happens *after* the match completes. So if a game just fizzles (someone rage-quits,
nobody reports), those 6 players cannot queue again until an admin runs `/match cancel`.

Same gap for `DRAFTING`: **there is no draft timer at all.** If a captain goes AFK mid-draft
the lobby hangs forever.

**Fix:** extend `checkQueueTimeouts` into a general sweeper:
- `IN_PROGRESS` older than ~2h → auto-cancel, ping the channel.
- `DRAFTING` idle >90s → auto-pick highest remaining MMR (you already have the bot-captain
  auto-pick logic in `votingService.ts:730` — reuse it) or hand the pick to the other captain.
- `READY_CHECK`/`VOTING` with no in-memory timer (i.e. after a restart) → cancel.

---

### P0-6. Restarting the bot mid-match strands the lobby

All phase timers live in module-local `Map`s (`activeVoteTimers`, `activeGambleTimers`,
`panelMoveTimers`) and the ready-check `setInterval`. `recoverStuckQueues` (`queueTimeout.ts:73`)
only resets queues whose match is **already** completed/cancelled — so a queue sitting in
`VOTING` with a live match is left in `VOTING` **with no timer to ever finalise it**.

**Fix:** in `recoverStuckQueues`, for any queue in `VOTING`/`CAPTAINS_VOTE`/`TEAMS_VOTE`/
`READY_CHECK` with a live match, either restart the timer from `created_at` or cancel the match
and refund players to the queue. Restarting is nicer; cancelling is 10 lines.

---

### P1-7. The match VS image disappears the moment anyone votes

`matchService.ts:521`

```ts
await msg.edit({ embeds: [embed] });
```

`buildActiveMatchEmbed` never calls `.setImage('attachment://match_vs.png')`, so the edited
embed has no image reference and the big VS card vanishes from the match message as soon as the
first report vote lands. Add `embed.setImage('attachment://match_vs.png')` in
`updateActiveMatchEmbed` (the attachment is still on the message; you don't need to re-upload).

---

### P1-8. The public feed card shows wrong MMR deltas

`channelService.ts:471-474`, called from `completeMatch` **after** MMR is already applied.

```ts
const { blueDelta, orangeDelta } = calculateMmrDelta(bluePlayers, orangePlayers, match.winner);
const blueResults = bluePlayers.map(p => ({ player: p, delta: blueDelta, newMmr: p.mmr }));
```

`bluePlayers` here is re-fetched *post-update*, so the Elo expectation is recomputed from the
new ratings — the feed shows a different delta than the one actually applied, and `newMmr` is
labelled as if it were the post-match value when the delta shown didn't produce it.

You already persist the real numbers in `gamble_status.blueDelta/orangeDelta`
(`matchService.ts:343`). Read those instead of recomputing.

---

### P1-9. `/stats`, `/leaderboard`, `/history` can blow the 3-second interaction deadline

`commands/stats.ts:30,58,128` — none of them call `deferReply()`, and all three do canvas
rendering plus avatar downloads first. On a cold avatar cache (bot just restarted, or a player
who hasn't been rendered in 15 min) that's up to 10 sequential HTTP fetches. Discord kills the
token at 3s and the user sees **"The application did not respond."**

Same in `interactionHandler.ts:97` (`queue_leaderboard` button) — replies without deferring.

**Fix:** `await interaction.deferReply()` first in all four. Cheap, and it's the single most
common cause of "the bot randomly doesn't respond".

---

### P1-10. Avatars are fetched one at a time inside the draw loop

`queueImage.ts:103` (and the same pattern in all 10 `*Image.ts` files):

```ts
for (let i = 0; i < 6; i++) {
  ...
  const img = await getCachedAvatarImage(client, player.discord_id, 128);
```

Six serial round-trips per render, and the queue panel re-renders on **every join, every leave,
and every chat message in the channel** (`handleChannelMessage` debounce). Prefetch once:

```ts
const avatars = new Map(
  await Promise.all(players.map(async p =>
    [p.discord_id, await getCachedAvatarImage(client, p.discord_id, 128)] as const))
);
```

Related: `pruneCache` (`avatarCache.ts:24`) is O(n log n) on every miss and evicts 25% at a
time. Fine at your scale, just noting it's not an LRU despite looking like one — `timestamp` is
set on *insert*, never refreshed on read, so hot avatars get evicted as readily as cold ones.

---

### P1-11. Rejecting balanced teams gives you random teams

`votingService.ts:655`

```ts
await startTeamsVotePhase(client, channelId, guildId, queue, true, message);
//                                                          ^^^^ isRandomize
```

`mode` defaults to `'random'`, and `isRandomize || mode === 'random'` routes to
`createRandomTeams`. So: everyone votes **Balanced MMR** → doesn't like the split → votes "No,
Randomize" → gets a **random** split, silently. The mode they voted for is gone.

Also, `createBalancedTeams` is deterministic — it returns the single lowest-diff split — so
there's nothing for it to re-roll *to* in balanced mode. You need a "next best balanced split"
(rank all 10 matchups by MMR diff, walk down the list) for that button to make sense.

---

### P1-12. Tie-breaking makes Balanced the default winner of every mode vote

`votingService.ts:234`

```ts
if (counts.balanced === maxVotes) winningMode = 'balanced';
```

With zero votes cast, `max = 0` and `balanced === 0` → balanced wins. Captains needs a strict
majority to ever beat balanced on a tie. If your group's favourite is Captains, they'll feel
like the vote is rigged. Consider: random tiebreak among the tied modes, or "most votes, ties
broken by a coin flip", and say which happened in the message.

---

### P1-13. `/ban add 30m` bans for thirty **months**

`commands/ban.ts:18,31`

```ts
const match = d.match(/^(\d+)([hdmw])$/);
...
} else if (unit === 'm') { now.setMonth(now.getMonth() + value); }
```

`m` is minutes to every human on earth. The command's own description doesn't list `m` at all.
Either map `m` → minutes and add `mo` for months, or reject `m` with a clear error.

Also: banning someone does **not** remove them from a queue they're already in — the check only
runs at join time (`queuePanel.ts:170`).

---

### P2-14. Everything else worth fixing

| Where | Issue |
| :--- | :--- |
| `matchService.ts:301` | Message says `4/4 votes reached` on cancel; the threshold is 4 **of 6**. Same `/4` in the embed. |
| `votingService.ts:244,252` | `const channel = ...` and `const players = ...` in `finalizeVoteAndPop` are computed and never used. |
| `channelService.ts:163-182` | `voiceOverrides` in `createMatchChannels` is built and never used — dead since VC creation moved to `createTeamVoiceChannels`. |
| `channelService.ts:26` | Category lookup uses `guild.channels.cache` — empty on a cold start before the cache fills. Use `fetch()`. Same in `match.ts:183` cleanup. |
| `votingService.ts:779` | Draft card is `delete()` + re-`send()` on every pick. Four picks = four new messages and a visible flicker. `edit()` instead. |
| `readyCheckService.ts:233` | `elapsed % 6 === 0` on a 3s interval — if a tick drifts past the boundary the ready-check image just skips a refresh. Track "last rendered second" instead. |
| `gambleService.ts:197` | Requires `agreedPlayers.length >= 6`. Any match containing a test bot can never resolve a gamble. |
| `completeMatch` → 90s channel delete vs. 60s gamble window | The gamble consensus window and the channel deletion timer are 60s and 90s. A late proposal gets its channel deleted mid-vote. |
| `queue.ts:206` | `/queue clear` doesn't clear `draft_state` / `captain_vote_state` / `team_vote_state`, and doesn't cancel the associated match — leaves orphaned channels. |
| `queries.ts:354` | `getActiveMatchForPlayer` scans and JSON-parses **every** active match in **every** guild. Fine now; add a `guild_id` filter before it matters. |
| `queries.ts:372` | Match-history player filter uses `blue_team LIKE '%"id"%'` — works, but a JSON-array column is the wrong shape. See "Schema" below. |
| `schema.ts:71-98` | Migrations are `try { ALTER TABLE } catch {}`. Any error is swallowed, including real ones. Use `PRAGMA table_info` to check first, and add a `schema_version` table. |
| `index.ts:87` | `uncaughtException` is logged and the process continues. After an uncaught exception the process is in an undefined state — log, then exit and let a supervisor restart. |
| `config.ts` | No validation. A missing `CLIENT_ID` fails silently at register time. Validate on boot and refuse to start with a clear message. |
| everywhere | `ephemeral: true` is deprecated in discord.js v14.16+. Use `flags: MessageFlags.Ephemeral`. It still works, but it'll warn and eventually break. |
| `interactionHandler.ts:146` | `parseInt(customId.split('_').pop())` — fine today, but it silently produces `NaN` for any malformed id and then queries match `NaN`. Guard it. |

---

## Part 2 — UX improvements

You said the goal is beating NeatQueue on feel. The bones are genuinely better already — image
cards, buttons over commands, the private per-match channel. Here's where the friction still is,
roughly in order of how much it'd improve a Friday night.

### The big ones

**1. Nothing tells you how long you've been in queue, or who's coming.**
The panel is a snapshot. Add to the queue image: time-in-queue per player ("4m"), and a
"typically pops in ~12 min at this hour" line (you already have `getAverageMatchDuration`; the
same idea for queue-to-pop time is a small query). NeatQueue's biggest complaint is people
sitting in a dead queue not knowing whether to wait — a "3/6, longest wait 22m" line fixes it.

**2. Ready check is all-or-nothing and punishing.**
Right now one AFK player kills the pop for everyone and the whole thing tears down. Better:
- Show a **live checklist** of who has connected (you do this every 6s — make it every 2s and
  make the *names* the primary content, not the timer).
- **Ping the AFK player directly** at T-20s, don't wait for failure.
- When it fails, keep the 5 ready players in the lobby and pull the **next person in queue**
  rather than dissolving back to the rank channel.
- Add a "I'm here" button as an alternative to joining VC — some people play with a phone in
  hand and Discord voice on another device.

**3. Reporting needs 4 of 6 and there's no dispute path.**
If Blue reports Blue and Orange reports Orange, you deadlock at 3-3 until an admin steps in.
Add: after both teams have 3 conflicting votes, auto-escalate — post a "⚠️ Disputed" state,
ping the mod role, and disable the report buttons so people stop mashing. Also a **score**
(e.g. 3-1) rather than just a winner would make history and disputes far more useful.

**4. The draft has no clock and no undo.**
Add a 60s per-pick timer with a visible countdown, auto-pick on expiry, and show the *pick
order* up front ("Blue picks 1st, Orange picks 2 & 3, last player goes to Blue") — 1-2-1 is
non-obvious and people will think it's broken the first time Orange picks twice in a row.

**5. Post-match, there's nowhere to go.**
The channel deletes in 90s and everyone's dumped back. Add a **"Requeue"** button on the result
card that drops all 6 straight back into the queue in one click. That single button is the
difference between 3 games a night and 6.

### Medium

- **Party/duo support.** Two friends who always want to be on the same team currently can't.
  Even a crude "🔗 Party with @x" that keeps two players on the same side in balanced/random
  mode would be a real differentiator over NeatQueue.
- **Show MMR change *before* the vote.** On the teams-vote card, show each team's average MMR
  and the predicted ± for winning/losing. People vote much more confidently.
- **Streak / rank-up moments.** You track `streak` but only surface it in `/stats`. A "🔥 4 win
  streak!" or "⬆️ RANK UP: Rank B → Rank A" callout on the result card is free dopamine.
- **The leaderboard buttons are on an ephemeral message.** Pagination via `interaction.update()`
  on an ephemeral reply with a *new* attachment is fragile. Either make the leaderboard public
  or drop the images from the paginated version.
- **`/help` should be a button on the panel**, not a command nobody runs.
- **Season resets.** No concept of a season. Even a manual `/season start` that snapshots and
  resets MMR gives your group a reason to grind again.

### Small but high-leverage

- The queue panel repositioning on every chat message (`handleChannelMessage`, 1200ms debounce)
  will feel janky in a chatty channel — every message deletes and re-posts a 840×380 PNG. Either
  raise the debounce to ~5s, or only re-post if the panel has scrolled more than N messages up.
- Ephemeral confirmations auto-delete after 6s (`autoDeleteReply`) — but ephemeral messages
  already vanish on their own and can't be seen by anyone else. The auto-delete adds a polling
  timer per interaction for no user-visible gain. Consider dropping it entirely.
- Lobby name `RL42` + password `317` is good. Make them **click-to-copy** by putting each on its
  own line in a code block — right now they're on one line so a mobile long-press grabs both.
- The result card says "GG!" and then the channel dies. Let people react/say gg for 3-5 minutes,
  not 90 seconds.
- Colour-blind friendliness: Blue vs Orange is fine, but the tier colours (`mmrService.ts:56`)
  put red at Rank X and purple at Rank A — hard to distinguish at emoji size for ~8% of men.

---

## Part 3 — Code & architecture

**What's good, genuinely:** the layering is sane (commands → services → queries), the split of
`queueService` into four focused modules with a barrel re-export was the right call, image
generation is isolated per-card, `handleJoinQueue`'s transactional add is correct, and there are
tests for the pure logic (draft/mmr) which is exactly where tests pay off.

**The main structural problem: the queue is a state machine that isn't written as one.**

`ActiveQueue.state` has 7 values and the transitions are spread across four files as ad-hoc
`if (queue.state !== 'X') return;` guards. Consequences you're already feeling:

- Every phase function independently re-implements "reset the source queue" (4 copies of the
  same 6-line block: `queuePanel.ts:302`, `readyCheckService.ts:161`, `votingService.ts:99`,
  `queueTimeout.ts:81`) and they've drifted — some clear `ready_check_vc_id`, some don't; some
  clear `draft_state`, none clear `captain_vote_state`.
- Timers are per-phase, in-memory, and unowned, so restarts strand lobbies (P0-6).
- There's no single place to ask "what should happen next?", so recovery has to guess.

**Suggested shape** (not a rewrite — an extraction):

```
src/state/
  machine.ts       // transition table: state × event → state + side effects
  timers.ts        // one registry: key → {expiresAt, onExpire}, persisted to SQLite
```

Persisting timer deadlines to the DB is what makes restart-safety fall out for free: on boot,
load all deadlines, fire the expired ones, re-arm the rest. That single change kills P0-5 and
P0-6 together.

**Other structural notes:**

- **`updateMatch` writes all 17 columns on every call.** It's a read-modify-write of the whole
  row with `undefined`-vs-`null` coalescing logic repeated 17 times (`queries.ts:433-449`).
  Build the `SET` clause dynamically from the keys actually present in `updates` — it removes
  ~40 lines and the whole class of "I forgot to add the new column to updateMatch" bugs.
- **JSON blobs in columns.** `blue_team`, `orange_team`, `vote_counts`, `report_status`,
  `gamble_status`, `draft_state` are all JSON text. This is why history filtering needs `LIKE
  '%"id"%'` and why every vote is a read-modify-write race. A `match_players(match_id,
  discord_id, team)` join table would fix querying *and* let you do per-vote `INSERT`s that
  can't race. That's the single highest-value refactor after the P0 list.
- **The 10 `*Image.ts` files are ~90% duplicated** — same gradient background, same rounded
  card, same avatar circle, same footer, ~1,600 lines total. Extract a small drawing kit
  (`drawCard`, `drawAvatar`, `drawBadge`, `drawHeader`, palette constants) and they'd collapse
  to ~60 lines each. This is also where a consistent visual identity comes from.
- **No `logger` levels or structure.** Every log is a string with interpolated values. When
  something goes wrong at 11pm mid-session you'll want `matchId` as a queryable field. Even
  swapping to `pino` with `logger.info({ matchId }, 'match started')` would pay off. At minimum,
  write logs to a file — right now everything is stdout-only and gone when the terminal closes.
- **`config.ts` reads `process.env` at import time**, which is why the test suite needed a
  `vitest.config.mts` to inject `DB_PATH` before module load. A `loadConfig()` function called
  from `index.ts` would be more testable.
- **`any` at the boundaries.** `parseQueueRow(row: any)`, `parseMatchRow(row: any)`, and the
  `permissionOverwrites` arrays are `any[]`. These are exactly the places where a schema change
  should produce a compile error and currently won't. Type the row shapes.
- **`tsconfig` is missing** `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Given
  how much of this code does `sorted[0]` and `players[i]`, the first one would catch real bugs.
  Also `"strict": true` is on but there's no `noImplicitOverride`/`noUnusedLocals` — the latter
  would have caught the dead code in P2-14.

---

## Part 4 — Testing

Current: 26 tests across 4 files, covering MMR math, draft combinatorics, the DB layer, and the
avatar cache. That's a good base — the pure functions are well covered.

**The gap is that nothing exercises a flow.** Every P0 above is in orchestration code, and none
of it has a single test. Highest-value additions, in order:

1. **A fake Discord client.** A ~100-line stub implementing `channels.fetch`, `send`, `edit`,
   `delete`, `guilds.fetch`, `channels.create` that records calls. Everything below needs it.
2. **Full-flow test:** 6 joins → ready check → mode vote → teams vote → match → report → Elo
   applied. One test that would have caught P0-1, P0-3, P1-7.
3. **Restart test:** put a queue in `VOTING`, run `recoverStuckQueues`, assert it doesn't strand
   (P0-6).
4. **Concurrency test:** fire 4 report votes without awaiting between them, assert all 4 land
   (P0-3).
5. **`getPlayersByIds` order test** (P0-1) — 3 lines, catches a bug affecting 6 screens.
6. **Image smoke tests:** call each `generate*Image` with representative data and assert it
   returns a non-trivial PNG buffer. Catches canvas crashes on odd usernames (emoji, RTL, 30
   chars) which will otherwise take down a whole interaction.

Also: `tests/db.test.ts` sets `process.env.DB_PATH` *after* its import statements, which does
nothing (ESM imports are hoisted). It only passed because `initializeDatabase()` created the
tables in whatever DB got opened — the real one. Fixed by `vitest.config.mts` + `tests/setup.ts`,
but worth knowing the original intent never worked.

---

## Part 5 — Ops & deployment

- **Fonts.** All canvas code uses `sans-serif`. On a headless Linux VPS with no fonts installed,
  every image renders as blank boxes. Bundle a font (`GlobalFonts.registerFromPath`) — and a
  colour emoji font if you want 🚀 to render in the images rather than tofu.
- **No Dockerfile / process manager / restart policy.** `better-sqlite3` and `@napi-rs/canvas`
  are native modules, so the build environment has to match the runtime. Pin Node 22 and build in
  the same image you run.
- **No backup of `6mans.sqlite`.** That file *is* everyone's rank. A nightly
  `VACUUM INTO 'backup-YYYY-MM-DD.sqlite'` (one line, safe on a live DB) is worth doing before
  your next session, not after you lose it.
- **`.env` is correctly gitignored** ✅ and no secrets are logged ✅.
- **The bot asks for `MessageContent` intent** (`index.ts:24`) but only uses messages to know
  when to reposition the panel — it never reads content. Drop the intent; it's a privileged one
  and you don't need it (`message.author.bot` and `channelId` are available without it).

---

## Suggested order of work

1. `getPlayersByIds` ordering (P0-1) — one function, fixes six screens.
2. `deferReply` on the four slow interactions (P1-9) — five lines, kills the most visible failure.
3. Transactional votes (P0-3) + `queue_channel_id` fix (P0-2).
4. Match/draft timeout sweeper (P0-5) and restart recovery (P0-6).
5. Ready-check re-pop fix (P0-4), VS image (P1-7), feed deltas (P1-8).
6. Then the UX list — starting with **Requeue button** and **queue wait times**, which give the
   most feel-improvement per line of code.
