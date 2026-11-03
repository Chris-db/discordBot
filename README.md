# Rocket League 6mans Discord Bot 🚀

A modern, high-performance **Rocket League 6mans Discord Bot** built with **Node.js**, **TypeScript**, **discord.js v14**, and **SQLite (`better-sqlite3`)**.

This bot solves the UI/UX friction and common complaints of legacy bots like **NeatQueue** by offering:
- **Interactive UI Buttons**: Join/leave queues, view stats, and inspect leaderboards without typing commands.
- **Three Mode Voting**: When 6 players join, vote between **Captains Draft**, **Balanced (ELO)**, or **Random**.
- **Interactive Captains Draft**: Captains draft teammates using a visual **Discord Select Menu (Dropdown)** showing player MMRs.
- **Automated Lobbies & Voice Channels**: Automatically generates a Rocket League Lobby Name/Password and creates temporary **Team Blue 🔵** and **Team Orange 🟠** voice channels.
- **Frictionless Reporting & Admin Override**: Players report match results with button confirmation; Admins and Mods can instantly override or cancel matches.

---

## 👋 For server admins (the bot is already running)

If someone is hosting the bot for you, setup is three steps:

1. **Invite the bot** with the link you were given. It needs *Manage Channels*, *Manage Roles*, *Manage Messages*, *View Channels*, *Send Messages*, *Read Message History*, *Embed Links*, *Attach Files*, *Connect*, *Speak*, *Move Members*, *Mention @everyone, @here and All Roles* — or simply *Administrator*. It creates private match channels, and Discord only lets a bot grant permissions it holds itself, so a bot short of any of these fails at the first match with `Missing Permissions`.
2. Run **`/setup`** in any channel. Pick how many rank divisions you want:
   - `One ladder` — everyone queues together. Right for most servers. It is called **6mans** everywhere (sidebar, panel, cards); pass `name:` to call it something else.
   - `Three` (C/B/A) or `All five` (C/B/A/X/S) — separate ladders, players are placed by an admin with `/division place`.
   Add `roles:true` if you want each rank category visible only to its rank role. `/setup` is safe to run again — it only adds what is missing. Run it once per team size (`size:2v2`, `size:4v4`) if you want more than 3v3.
3. Players click **Join Queue** on the panel in their rank channel. That is it.

Bug or idea? Anyone can type **`/feedback <message>`** — it goes straight to the maintainer.

---
## 🛠️ Quick Setup Guide

### 1. Create a Discord Bot Application
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Under the **Bot** tab:
   - Click **Reset Token** and copy your **Bot Token**.
   - Enable the following **Privileged Gateway Intents**:
     - `Server Members Intent` (optional, for member lookups)
3. Under the **OAuth2 -> URL Generator** tab:
   - Select scopes: `bot` and `applications.commands`.
   - Select bot permissions:
     - **Recommended (Easiest Setup)**: Select **Administrator** so the bot can freely create private match channels, set permission overwrites, and auto-move players without API `50013 Missing Permissions` errors.
     - **Granular Permissions (if not using Administrator)**:
       - `Manage Channels` & `Manage Roles` (called **Manage Permissions**; required by Discord API v10 to create channels with custom permission overwrites)
       - `Manage Messages` (required for score reporting, button interaction cleanup, and match cancel overrides)
       - `Move Members` (required to auto-move players into voice channels)
       - `Send Messages`, `Embed Links`, `Read Message History`, `Connect`, `Speak`, `Use Application Commands`
       - `Mention @everyone, @here and All Roles` (the first player into an empty queue pings that division's role; the roles `/setup` creates are not mentionable by members, so without this the ping posts but notifies nobody)
4. Copy the generated OAuth2 invite URL and invite the bot to your Discord server!
5. **In your Discord Server (`Server Settings -> Roles`)**, ensure the Bot's role has **Administrator** (or all permissions listed above) checked, and delete any existing `🎮 ACTIVE 6MANS MATCHES` category if it was created with restrictive permissions.

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Open `.env` and fill in:
- `DISCORD_TOKEN`: Your Discord Bot Token
- `CLIENT_ID`: Your Discord Application Client ID
- `GUILD_ID`: (Optional) Your Discord Server (Guild) ID for instant slash command registration

### 3. Install & Start
```bash
# Install dependencies
npm install

# Register slash commands with Discord (optional: the bot also registers on boot)
npm run register

# Run the bot in development mode
npm run dev

# Or build for production
npm run build
npm start
```

---

## 🎮 Slash Commands

Commands marked *Admin* are hidden from members by Discord's default permissions; server
admins can change who sees them under *Server Settings → Integrations*. Most commands that
read a ladder take an optional `size:` (2v2 / 3v3 / 4v4), defaulting to 3v3.

| Command | Who | What it does |
| :--- | :--- | :--- |
| `/setup` | Admin | Creates rank categories, queue channels, panels and (optionally) roles in one go; safe to re-run |
| `/queue panel [size] [division]` | Admin | Registers this channel as a queue and posts the panel |
| `/queue status` | Everyone | Current queue and who is waiting |
| `/queue add` / `remove <user>` | Admin | Adds or removes a player by hand (an admin add bypasses the division gate) |
| `/queue clear` | Admin | Empties the queue |
| `/queue fill-bots` | Admin | Pads the queue with test bots, for solo testing |
| `/queue force-pop [mode]` | Admin | Fills and pops now, in `balanced`, `captains` or `random` |
| `/match list` | Everyone | Live matches |
| `/match report <winner> [match]` | Admin | Settles a result (`match` is the N in `#match-N`; defaults to this channel's match) |
| `/match cancel [match]` | Admin | Cancels a match and removes its channels |
| `/match cleanup [match]` / `cancel-all` | Admin | Tidies leftover match channels / cancels every live match |
| `/replay check <files> [match]` | Admin | Reads `.replay` uploads and posts the scoreboards, to settle a dispute; never changes a result |
| `/stats [user]` | Everyone | Profile card: MMR, division, W/L, streak |
| `/leaderboard` | Everyone | Top players on a ladder |
| `/history [user]` | Everyone | Recent matches |
| `/set-mmr <user> <mmr>` | Admin | Sets a player's MMR |
| `/division list` / `check [user]` | Everyone | Divisions with their thresholds and channels / a player's division |
| `/division place` / `configure` | Admin | Puts a player in a division / changes a division's name, channel, role or thresholds |
| `/season info` / `history` | Everyone | The current season / past seasons and their champions |
| `/season end confirm:<name>` | Admin | Ends the season: snapshots standings, promotes/relegates, resets every MMR to its division's default. Refuses while anything is live. Never runs on its own |
| `/ban add` / `remove` / `check` / `list` | Admin | Queue bans: `30m`, `12h`, `7d`, `2w`, `1mo` or `permanent` |
| `/theme set` / `reset` / `preset` / `list` / `show` | Admin | The server's card colours |
| `/feedback <message>` | Everyone | Sends a bug report or idea to the maintainer (files a GitHub issue) |
| `/help` | Everyone | How the bot works |

---

## 🏆 Ranks

Players sit in a **division** (C, B, A, X, S; or one ladder for the whole server), each with
its own starting MMR (1000 / 1300 / 1500 / 1700 / 1900). MMR moves every match; the
division only changes at a season end, by promotion or relegation, or when an admin uses
`/division place`.

---

## 📚 Docs

| Doc | What's in it |
|---|---|
| [PROGRESS.md](PROGRESS.md) | Status and the backlog of what is left to do |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the code works, settled design, rules |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deploying to the Pi, logs, backups, the dev bot |
| [docs/TESTING.md](docs/TESTING.md) | Checklist for a live test run |
| [docs/PITCH.md](docs/PITCH.md) | Copy for offering the bot to a new server |
| [docs/history/](docs/history/) | The original audit and the build log |
