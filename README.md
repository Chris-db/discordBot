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

1. **Invite the bot** with the link you were given. It needs *Manage Channels*, *Manage Roles* (only if you want rank roles), *View Channels*, *Send Messages*, *Attach Files*, *Move Members*.
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

# Register slash commands with Discord
npm run register

# Run the bot in development mode
npm run dev

# Or build for production
npm run build
npm start
```

---

## 🎮 Slash Commands

| Command | Permission | Description |
| :--- | :--- | :--- |
| `/setup` | Admin | Creates rank categories, queue channels, panels and (optionally) roles in one go; safe to re-run |
| `/feedback <message>` | Everyone | Sends a bug report or suggestion to the maintainer (filed as a GitHub issue) |
| `/queue panel` | Admin / Mod | Spawns the persistent interactive queue panel with Join/Leave buttons |
| `/queue status` | Everyone | Displays current queue status and players waiting |
| `/queue add <user>` | Admin / Mod | Manually adds a player to the current queue |
| `/queue remove <user>` | Admin / Mod | Manually removes a player from the current queue |
| `/queue clear` | Admin / Mod | Clears the active queue |
| `/queue fill-bots` | Admin / Mod | Fills remaining empty slots with simulated AI bot players (`test_bot_1..5`) for solo testing |
| `/queue force-pop [mode]` | Admin / Mod | Instantly fills to 6 players and pops a match in a specific mode (`balanced`, `captains`, or `random`) |
| `/match report <id> <winner>` | Admin / Mod | Manually force-reports a match winner (`blue` or `orange`) |
| `/match cancel <id>` | Admin / Mod | Manually cancels an active match and removes temporary channels |
| `/match cleanup [id]` | Admin / Mod | Cleans up temporary match text and voice channels |
| `/match list` | Everyone | Lists all currently active matches |
| `/stats [user]` | Everyone | Shows ELO rating, rank tier, wins, losses, win rate, and streak |
| `/leaderboard` | Everyone | Displays the server's top players by ELO |
| `/set-mmr <user> <mmr>` | Admin / Mod | Sets a player's ELO rating |
| `/help` | Everyone | Shows instructions, rules, and features |

---

## 🏆 ELO Rank Tiers
- **Supersonic Legend**: 1600+ MMR
- **Grand Champion**: 1400 - 1599 MMR
- **Champion**: 1200 - 1399 MMR
- **Diamond**: 1000 - 1199 MMR
- **Platinum**: 800 - 999 MMR
- **Gold & Below**: < 800 MMR
