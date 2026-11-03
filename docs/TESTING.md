# Live test checklist

The order to exercise the bot in Discord after a risky change, and what should happen at
each step, so a wrong result is obvious at once rather than three matches later. Run it on
the dev bot (`OPERATIONS.md`, "Testing a branch on the dev bot") before merging, or on the
real server after.

Work down the list and stop at the first thing that misbehaves; later steps assume the
earlier ones worked. Steps 1 to 4 were all passed on the real server in September 2026;
step 5 has never been run.

## Before you start

- **Only one bot process per token.** Two both receive every interaction and race to
  answer it; the loser throws `DiscordAPIError[10062] Unknown interaction`, which looks
  exactly like a performance problem and is not one.
- Slash commands register on boot. If a new option is missing, give Discord a minute.
- `/queue fill-bots` pads a queue with test bots. Vote thresholds count humans only, so
  in a padded lobby your one vote decides.

## 1. It boots and the panel renders

`/queue panel` in a queue channel, or `/setup` on a fresh server.

- Panel says **3V3** (or the server's ladder name), six empty slots, `0 / 6`.
- A wrong size means the channel is registered to another one: `/queue panel size:3v3`.

## 2. A full match, start to finish

`/queue fill-bots` then join yourself, or get six people in.

| Step | What should happen |
|---|---|
| Queue fills | Panel shows `6 / 6`, and the division role ping comes down |
| Ready check | A `🔊 Ready Check #N` VC with a 6-person limit, and a `#match-N` text channel only the lobby can see |
| Everyone joins the VC | The ready-check card ticks each player to ✅, then mode voting starts |
| Mode vote | Resolves the moment the majority is reached, rather than waiting out the deadline |
| Teams | Blue and Orange VCs with a 3-person limit each, and you get moved into yours |
| Lobby card | RL lobby name and password, each on its own line |
| Report | `Blue Win: 1/4` on the card; completes at the majority |
| Result card | Real MMR deltas, a streak badge on anyone at 3+, promotion/relegation arrows |

The parts tests cannot reach: VC creation and permission overwrites, moving players
between voice channels, and channel teardown. Watch those.

## 3. After the match

On the result card, within 3 minutes:

- **Run it back**: same teams, new lobby credentials, `REMATCH — GAME 2`, a series line,
  and the channel and VCs renamed to the new match number.
- `/history`: the two games are separate rows, each showing the series score *after* it
  (`GAME 1 • 1–0`, then `GAME 2 • 1–1` or `2–0`).
- **Back to Queue** puts the whole lobby back in the queue channel in one click.
- **🎰 Gamble**: every human agrees → the wheel spins and lands → a separate result card
  with MMR doubled or flipped. With "Automatically play GIFs" off in Discord's settings,
  the wheel shows "▶ Tap to spin" until tapped.

## 4. The things that only fail on a timer

Worth provoking on purpose, because they are silent when they break:

- **AFK ready check**: someone never joins the VC. At the deadline they are dropped with a
  5-minute cooldown, the match cancels, and the rest go to the front of the queue.
- **Draft auto-pick**: a captain sits for 90 s. It auto-picks and says so.
- **Channel teardown**: after the rematch window, `#match-N` and both team VCs are gone,
  and no `Ready Check #N` VC is left behind.

## 5. Other team sizes (never run live)

A size exists only once a channel is registered to it. In a **new** channel inside a
Discord category (match channels are created as siblings, so a channel outside a category
errors):

```
/queue panel size:4v4 division:A
```

- Panel is wider: 4 columns × 2 rows, `0 / 8`.
- Ready-check VC limit 8, team VCs 4 each, report needs **5** votes.
- Captains pick in the order **B, O, O, B, B**, then the last player is auto-assigned. The
  draft card is taller and its pool shows all 6 available players.
- `/stats` with no `size:` still shows 3v3. `/stats size:4v4` shows 1000 MMR and 0 games for
  someone who has only played 3v3: that is the ladders being separate, not a bug.

Repeat with `size:2v2` (report needs 3 votes).

## If something goes wrong

`journalctl -u 6mans -f` on the Pi (or the dev bot's console) shows what happened, and an
error also opens a `bot-error` issue. Revert the merge on GitHub and the Pi redeploys the
previous `main` within 15 minutes.
