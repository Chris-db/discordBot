# First live session checklist

Nothing in phases 1–5 has ever run against Discord. This is the order to exercise it in,
and what should happen at each step — so a wrong result is obvious rather than something
you notice three matches later.

Work down the list. Stop at the first thing that misbehaves; the later steps assume the
earlier ones worked.

## Before you start

```bash
npm run register
```

Slash commands gained new `size:` options; they will not appear in Discord until this
runs. It can take a minute for Discord to show them.

- **Only one bot process.** Two on one token both receive every interaction and race to
  answer it — the loser throws `DiscordAPIError[10062] Unknown interaction`, which looks
  exactly like a performance problem and is not one. Check with
  `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"`.
- The first start applies migrations 1–4 to `data/6mans.sqlite`. It is fatal on error by
  design — a half-migrated ranks table is worse than a bot that refuses to boot. Nightly
  backups are in `data/backups/` if you need to go back.
- Expect `SQLite schema initialized (4 migration(s) applied).` in the log, once.

## 1. It boots and the panel renders

`/queue panel` in your queue channel.

- Panel says **3V3 MATCH QUEUE**, six empty slots, `WAITING FOR PLAYERS • 0 / 6`.
- If it says 2v2 or 4v4, the channel is registered to a different size — `/queue panel
  size:3v3` to fix.

## 2. A full match, start to finish

`/queue fill-bots` then join yourself, or get six people in.

| Step | What should happen |
|---|---|
| Queue fills | Panel turns green, `QUEUE FULL • 6 / 6 READY!` |
| Ready check | A `🔊 Ready Check #N` VC appears with a 6-person limit, and a `#match-N` text channel you can see and others cannot |
| Everyone joins the VC | Ready-check card ticks each player to ✅, then mode voting starts |
| Mode vote | Footer says **4 votes** required. Vote; at 4 it resolves immediately rather than waiting out the 30s |
| Teams | Blue and Orange VCs appear with a 3-person limit each, and you get moved into yours |
| Lobby card | Names the RL lobby and password, and says "your private 3v3 match" |
| Report | `Blue Win: 1/4` on the card. At 4 votes it completes |
| Result card | Real MMR deltas, and a streak badge on anyone at 3+ |

**The riskiest bits here are the ones I could not test:** VC creation and permission
overwrites, getting moved between voice channels, and the channel teardown. Watch those.

## 3. Rematch and requeue

On the result card, within 3 minutes:

- **Run it back** → same teams, new lobby credentials, `REMATCH — GAME 2`, and a
  `📊 Series so far: 🔵 1 — 0 🟠` line.
- Report that one too, then `/history` — the two games should be separate rows, each
  showing where the series stood *after* it (`GAME 1 • 1–0`, then `GAME 2 • 1–1` or
  `2–0`). If both rows show the same score, the `uptoGame` bound is broken.
- **Back to Queue** on a result card should put the whole lobby back in the queue channel
  in one click.

## 4. The things that only fail on a timer

Worth provoking deliberately, because they are silent when they break:

- **AFK ready check** — have someone not join the VC. After 60s they are dropped, the
  match cancels, and the rest go back to the front of the queue. If a 7th person joined
  meanwhile, it should re-pop immediately rather than stranding anyone.
- **Draft auto-pick** — in a captains draft, let a captain sit for 90s. It should
  auto-pick the highest-MMR player left and say so, not hang forever.
- **Channel teardown** — after the 3-minute rematch window, `#match-N` and both team VCs
  should disappear. Check no `Ready Check #N` VC is left orphaned.

## 5. Multi-queue, when you want it

Nothing above needs this — a size only exists once you register a channel.

```
/queue panel size:4v4 division:A
```

in a **new** channel that sits inside a Discord category (match channels are created as
siblings, so a channel outside a category will error).

- Panel is wider, 4 columns × 2 rows, `0 / 8`.
- Fill it: ready-check VC limit is 8, team VCs are 4 each, report needs **5** votes.
- Captains draft picks in the order **B, O, O, B, B**, then the last player is
  auto-assigned. The draft card is taller and the pool shows all 6 available players.
- `/stats` with no `size:` still shows 3v3. `/stats size:4v4` should show 1000 MMR and
  0 games for someone who has only played 3v3 — that is the ladders being separate, not
  a bug.

## If something goes wrong

- The whole stack is on `main`, unpushed. `git reset --hard 818432c` puts `main` back to
  where it was before this work; the branches are all still there.
- The migration is the one thing that is not trivially reversible. It has been dry-run
  against a copy of your live database — every player kept their exact MMR — but if you
  want a belt-and-braces copy first: `cp data/6mans.sqlite data/6mans.pre-phase5.sqlite`.
