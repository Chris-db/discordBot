import { EmbedBuilder } from 'discord.js';
import { Player } from '../database/queries';

export const RL_COLORS = {
  ORANGE: 0xff5722,
  BLUE: 0x2979ff,
  GREEN: 0x00e676,
  PURPLE: 0xaa00ff,
  GOLD: 0xffb300,
  RED: 0xff1744,
  DARK: 0x263238,
};

/**
 * Every card in this bot is a generated PNG that already draws the rosters, MMR, deltas,
 * timers and vote tallies. An embed that repeats any of that is the same information a
 * third time -- once in the message content, once in the embed, once in the image.
 *
 * So the embeds below carry only what a PNG physically cannot: text you can copy, and
 * mentions/channels you can click. Vote counts live on the buttons, which already show
 * them. Everything else is the image's job.
 */

const mentions = (players: Player[]) => players.map(p => `<@${p.discord_id}>`).join(', ');

const avgMmr = (team: Player[]) =>
  team.length > 0 ? Math.round(team.reduce((sum, p) => sum + p.mmr, 0) / team.length) : 0;

/**
 * Captain verification vote. The buttons carry the yes/no tallies and the re-roll label,
 * so all this needs to say is who the two captains are.
 */
export function buildCaptainsVoteEmbed(blueCaptain: Player, orangeCaptain: Player): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Captain Vote')
    .setColor(RL_COLORS.PURPLE)
    .setDescription(
      `🔵 <@${blueCaptain.discord_id}>\n` +
      `🟠 <@${orangeCaptain.discord_id}>`
    );
}

/**
 * Team verification vote for Random / Balanced. No image is generated for this phase, so
 * this embed is the card -- but it still only needs the two rosters and how far through
 * the re-roll pool the queue is.
 */
export function buildTeamsVoteEmbed(
  blueTeam: Player[],
  orangeTeam: Player[],
  seenCount: number = 1,
  mode: 'random' | 'balanced' = 'random',
  totalMatchups: number = 10
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Team Vote — ${mode === 'balanced' ? 'Balanced' : 'Random'}`)
    .setColor(RL_COLORS.BLUE)
    .setDescription(
      `🔵 \`${avgMmr(blueTeam)}\` ${mentions(blueTeam)}\n` +
      `🟠 \`${avgMmr(orangeTeam)}\` ${mentions(orangeTeam)}\n` +
      `Matchup ${seenCount} of ${totalMatchups}`
    );
}

/**
 * The active match card. The VS image draws both rosters, so this is just the two things
 * you have to act on: the lobby credentials (copyable) and your team's voice room
 * (clickable). The report tally is appended only once someone has actually reported.
 */
export function buildActiveMatchEmbed(
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  _blueTeam: Player[],
  _orangeTeam: Player[],
  rlName: string,
  rlPass: string,
  blueVoiceId?: string,
  orangeVoiceId?: string,
  reportStatus?: {
    blueVotes?: string[];
    orangeVotes?: string[];
    cancelVotes?: string[];
  },
  votesRequired: number = 4
): EmbedBuilder {
  // One credential per line. Clicking an inline code span copies it on desktop, and a
  // long-press on mobile selects the line -- with both on one line it grabbed both.
  const lines = [`**Name** \`${rlName}\``, `**Password** \`${rlPass}\``];

  // These two used to be accepted and never rendered, so "join your team's voice room"
  // pointed at nothing clickable.
  const voiceLinks = [
    blueVoiceId ? `🔵 <#${blueVoiceId}>` : '',
    orangeVoiceId ? `🟠 <#${orangeVoiceId}>` : '',
  ].filter(Boolean);
  if (voiceLinks.length > 0) {
    lines.push(voiceLinks.join('   '));
  }

  const blue = reportStatus?.blueVotes?.length || 0;
  const orange = reportStatus?.orangeVotes?.length || 0;
  const cancel = reportStatus?.cancelVotes?.length || 0;
  if (blue > 0 || orange > 0 || cancel > 0) {
    lines.push(
      `Reported — Blue \`${blue}/${votesRequired}\`  Orange \`${orange}/${votesRequired}\`  Cancel \`${cancel}/${votesRequired}\``
    );
  }

  return new EmbedBuilder()
    .setTitle(`Match #${matchNumber}`)
    .setColor(0x00b0ff)
    .setDescription(lines.join('\n'));
}

/**
 * Read-only card for the public #active-matches feed. No image is generated for the feed,
 * and spectators are not in the lobby, so this keeps the rosters -- but not the running
 * commentary about what a match is.
 */
export function buildPublicFeedCardEmbed(
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
  bluePlayers: Player[],
  orangePlayers: Player[],
  winner?: 'BLUE' | 'ORANGE'
): EmbedBuilder {
  let title = `Match #${matchNumber} — Live`;
  let color = RL_COLORS.GREEN;

  if (status === 'COMPLETED') {
    title = `Match #${matchNumber} — ${winner === 'BLUE' ? '🔵 Blue' : '🟠 Orange'} win`;
    color = winner === 'BLUE' ? RL_COLORS.BLUE : RL_COLORS.ORANGE;
  } else if (status === 'CANCELLED') {
    title = `Match #${matchNumber} — Cancelled`;
    color = RL_COLORS.RED;
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(
      `🔵 \`${avgMmr(bluePlayers)}\` ${mentions(bluePlayers) || 'N/A'}\n` +
      `🟠 \`${avgMmr(orangePlayers)}\` ${mentions(orangePlayers) || 'N/A'}`
    );
}

/**
 * Double or Nothing consensus. The stakes have to be stated once -- players are agreeing
 * to a 50/50 on their own MMR -- but two lines is enough for that.
 */
export function buildGambleConsensusEmbed(
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  blueTeam: Player[],
  orangeTeam: Player[],
  agreedIds: string[],
  // Unix seconds. Discord renders `<t:…:R>` as "in 45 seconds" and ticks it on every
  // viewer's screen by itself. This used to be a seconds-remaining number, which was only
  // as fresh as the last click that re-rendered the card.
  deadlineUnixSeconds: number
): EmbedBuilder {
  const rosterSize = blueTeam.length + orangeTeam.length;

  const roster = (players: Player[]) =>
    players.map(p => `${agreedIds.includes(p.discord_id) ? '✅' : '⏳'} ${p.username}`).join('\n');

  return new EmbedBuilder()
    .setTitle(`Double or Nothing — Match #${matchNumber}`)
    .setColor(RL_COLORS.GOLD)
    .setDescription(
      `A 50/50 spin. Losers win the wheel → the result flips. Winners win it → MMR is doubled.\n` +
      `All ${rosterSize} must agree. Closes <t:${deadlineUnixSeconds}:R>.`
    )
    .addFields(
      { name: '🔵 Blue', value: roster(blueTeam), inline: true },
      { name: '🟠 Orange', value: roster(orangeTeam), inline: true }
    );
}
