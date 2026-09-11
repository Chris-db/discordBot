import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  Attachment,
} from 'discord.js';
import { getMatchByNumber, getMatchByTextChannel, getPlayersByIds } from '../database/queries';
import { parseReplayHeader, ReplayHeader } from '../utils/replayHeader';
import { summariseSeries, formatSeries } from '../services/replayReport';
import { logger } from '../utils/logger';

/**
 * `/replay check` -- the dispute tool. An admin drops the saved `.replay` files from a
 * disputed series into the command (one per option, up to five for a BO5) and gets the
 * scoreboard of every game plus the series tally, read straight from the files.
 *
 * It is a slash command with attachment options rather than "drop a file in the channel"
 * because a bot only sees attachments on ordinary messages with the privileged Message
 * Content intent, which this bot does not ask for. A command also works from any
 * channel, so it can live wherever the admins talk.
 *
 * It never changes a result. The admin reads the evidence and settles the match with
 * `/match report`, which is one command and one deliberate decision.
 */

const MAX_FILES = 5;
const MAX_BYTES = 16 * 1024 * 1024;

async function downloadReplay(attachment: Attachment): Promise<Buffer> {
  if (attachment.size > MAX_BYTES) {
    throw new Error(`${attachment.name} is ${Math.round(attachment.size / 1024 / 1024)}MB -- a replay is a few MB at most.`);
  }
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Could not download ${attachment.name} (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

export const replayCommand = {
  data: new SlashCommandBuilder()
    .setName('replay')
    .setDescription('Read Rocket League replay files (Admin/Mod)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(sub => {
      sub
        .setName('check')
        .setDescription('Read the score and players out of saved .replay files, e.g. to settle a disputed report')
        .addAttachmentOption(opt =>
          opt.setName('file1').setDescription('A .replay file (Documents\\My Games\\Rocket League\\TAGame\\Demos)').setRequired(true)
        );
      for (let i = 2; i <= MAX_FILES; i++) {
        sub.addAttachmentOption(opt =>
          opt.setName(`file${i}`).setDescription(`Another game of the same series`).setRequired(false)
        );
      }
      sub.addIntegerOption(opt =>
        opt.setName('match').setDescription('Match number (the N in #match-N) to compare against; defaults to the match in this channel').setRequired(false)
      );
      return sub;
    }),

  async execute(interaction: ChatInputCommandInteraction) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
    if (!isAdmin) {
      return interaction.reply({
        content: '❌ You need **Manage Channels** permission to read replays.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const attachments: Attachment[] = [];
    for (let i = 1; i <= MAX_FILES; i++) {
      const a = interaction.options.getAttachment(`file${i}`);
      if (a) attachments.push(a);
    }

    // Downloading and parsing is well past the 3s window. The reply is public on
    // purpose: the point is that everyone in the argument sees the same scoreboard.
    await interaction.deferReply();

    const parsed: ReplayHeader[] = [];
    const failures: string[] = [];
    for (const a of attachments) {
      try {
        parsed.push(parseReplayHeader(await downloadReplay(a)));
      } catch (err) {
        failures.push(`**${a.name}**: ${(err as Error).message}`);
        logger.warn(`Replay ${a.name} could not be read:`, err);
      }
    }

    if (parsed.length === 0) {
      return interaction.editReply({
        content: `❌ None of the files could be read as a Rocket League replay.\n${failures.join('\n')}`,
      });
    }

    const number = interaction.options.getInteger('match');
    const match =
      number !== null
        ? getMatchByNumber(interaction.guildId!, number)
        : getMatchByTextChannel(interaction.channelId);
    const rosters = match
      ? {
          blue: getPlayersByIds(match.guild_id, match.team_size, match.blue_team),
          orange: getPlayersByIds(match.guild_id, match.team_size, match.orange_team),
        }
      : undefined;

    const summary = summariseSeries(parsed, match);
    if (number !== null && !match) {
      summary.warnings.unshift(`Match #${number} does not exist in this server.`);
    }
    for (const f of failures) summary.warnings.push(`Could not read ${f}`);

    const content = formatSeries(summary, match, rosters);
    // Discord caps a message at 2000 characters; five 4v4 scoreboards can exceed it.
    return interaction.editReply({
      content: content.length <= 2000 ? content : content.slice(0, 1990) + '\n…',
    });
  },
};
