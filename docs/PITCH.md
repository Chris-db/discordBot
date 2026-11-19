# Pitch for a new server

Copy-paste material for offering the bot to a Discord server. Invite link is the bot's
public application id plus the permissions it actually uses — nothing secret in it.

## The DM (send to the server owner / an admin)

> Hey — I built a 6mans bot for Rocket League and I'm looking for one or two SA servers
> to run it on for free. Curious if yours would want it?
>
> What it does: players click **Join** in a queue channel, when it's full it makes a
> private lobby channel + team voice channels, gives everyone the RL lobby name/password,
> teams vote captains/balanced/random, and after the game one click reports the winner
> and updates everyone's rank. Ranks reset monthly. 2v2, 3v3 and 4v4 all work.
>
> Setup is literally one command (`/setup`) — it makes the channels for you. I run and
> maintain it myself, so if something breaks or you want something changed, tell me.
>
> It's free, no strings. Want the invite link?

## When they say yes

> Invite link (it pre-ticks the permissions it needs — nothing more):
> https://discord.com/oauth2/authorize?client_id=1532648468072370318&scope=bot%20applications.commands&permissions=288484368
>
> Once it's in, an admin runs **`/setup`** in any channel:
> - small server, everyone plays together → just `/setup`
> - want rank divisions → `/setup divisions:three` (or `all`), add `roles:true` if you
>   want each rank category visible only to that rank
>
> Then players click **Join Queue** in the channel it made. `/help` covers everything else.

## What the permissions are for (if they ask)

| Permission | Why |
|---|---|
| Manage Channels | creates the rank categories, queue channels, and the per-match text + voice channels (deleted after the game) |
| Manage Roles | only used if they choose `roles:true` in `/setup` |
| Manage Messages | keeps the queue panel pinned / re-posts it at the bottom |
| Move Members | moves players into their team voice channel when a match starts |
| View / Send / Attach / Embed / History / Connect / Speak | the normal stuff — posting the cards, seeing the channels, voice channel creation |

No Administrator. No reading message content.

## Answers to likely questions

- **Where does it run?** On my own machine at home, 24/7, with uptime monitoring. If it
  goes down I get paged.
- **What happens to our data?** Ranks and match history live in the bot's database. If you
  stop using it, tell me and I delete your server's rows.
- **Does it need anything on players' PCs?** No. Disputes can be settled by uploading the
  saved `.replay` file with `/replay check`.
- **Can we keep our existing roles/channels?** Yes — `/setup` reuses anything with a
  matching name and only adds what's missing.
