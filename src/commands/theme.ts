import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} from 'discord.js';
import { getDivisionByChannel } from '../database/queries';
import {
  THEME_TOKENS,
  THEME_PRESETS,
  ThemeToken,
  normaliseHex,
  readToken,
  DEFAULT_PALETTE,
} from '../ui/palette';
import {
  getGuildOverrides,
  getGuildPalette,
  setGuildToken,
  resetGuildTheme,
  applyGuildPreset,
  withGuildTheme,
} from '../services/themeService';
import { renderThemePreview } from '../ui/themePreview';
import { logger } from '../utils/logger';

/**
 * `/theme` -- a server's colours for every image card, set from Discord.
 *
 * Tokens are a dropdown (there are fewer than 25), colours are typed as hex because
 * Discord has no colour picker. `show` renders two cards under the current theme so a
 * change is seen before players see it. Only overrides are stored; `reset` returns a
 * token, or everything, to the bot's defaults.
 */

const TOKEN_DESCRIPTIONS: Record<ThemeToken, string> = {
  accent: 'Highlight: MMR figures, titles, unregistered panels',
  positive: 'Full queue, ready, MMR gained, win',
  negative: 'MMR lost, loss',
  gold: 'Captains, promotion zone, Rank S',
  amber: 'Leaderboard heading, match card badge',
  purple: 'Mode vote heading, draft pool',
  warning: 'Not-ready player on the ready check',
  sky: 'Stat figures: leaderboard MMR, win rate',
  bgTop: 'Background gradient, top',
  bgBottom: 'Background gradient, bottom',
  card: 'Filled player card',
  cardEmpty: 'Empty queue slot',
  surface: 'Avatar fallback, idle borders',
  text: 'Main text',
  textMuted: 'Secondary text',
  'team.blue': 'Team Blue',
  'team.orange': 'Team Orange',
  'division.C': 'Rank C colour',
  'division.B': 'Rank B colour',
  'division.A': 'Rank A colour',
  'division.X': 'Rank X colour',
  'division.S': 'Rank S colour',
};

const tokenChoices = THEME_TOKENS.map(t => ({ name: `${t} — ${TOKEN_DESCRIPTIONS[t]}`.slice(0, 100), value: t }));
const presetChoices = Object.keys(THEME_PRESETS).map(name => ({ name, value: name }));

export const themeCommand = {
  data: new SlashCommandBuilder()
    .setName('theme')
    .setDescription("This server's colours for the bot's image cards (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('Set one colour')
        .addStringOption(opt =>
          opt.setName('token').setDescription('Which colour').setRequired(true).addChoices(...tokenChoices)
        )
        .addStringOption(opt =>
          opt.setName('colour').setDescription('Hex, e.g. #ff9100').setRequired(true).setMinLength(6).setMaxLength(7)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('reset')
        .setDescription('Put one colour, or every colour, back to the default')
        .addStringOption(opt =>
          opt.setName('token').setDescription('Which colour (omit for all)').setRequired(false).addChoices(...tokenChoices)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('preset')
        .setDescription('Replace the theme with a built-in one')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Preset').setRequired(true).addChoices(...presetChoices)
        )
    )
    .addSubcommand(sub => sub.setName('list').setDescription('Show every colour and which are overridden'))
    .addSubcommand(sub => sub.setName('show').setDescription('Render a queue panel and a result card in the current theme')),

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ You need **Manage Server** permission to change the theme.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const token = interaction.options.getString('token', true) as ThemeToken;
      const hex = normaliseHex(interaction.options.getString('colour', true));
      if (!hex) {
        return interaction.reply({
          content: '❌ That is not a colour. Use six hex digits, e.g. `#ff9100`.',
          flags: MessageFlags.Ephemeral,
        });
      }
      setGuildToken(guildId, token, hex);
      logger.info(`Guild ${guildId}: theme ${token} = ${hex} by ${interaction.user.id}`);
      return replyWithPreview(interaction, guildId, `✅ \`${token}\` is now \`${hex}\`.`);
    }

    if (sub === 'reset') {
      const token = interaction.options.getString('token') as ThemeToken | null;
      resetGuildTheme(guildId, token ?? undefined);
      return replyWithPreview(
        interaction,
        guildId,
        token ? `✅ \`${token}\` is back to the default (\`${readToken(DEFAULT_PALETTE, token)}\`).` : '✅ Theme reset to the defaults.'
      );
    }

    if (sub === 'preset') {
      const name = interaction.options.getString('name', true);
      if (!applyGuildPreset(guildId, name)) {
        return interaction.reply({ content: `❌ No preset called \`${name}\`.`, flags: MessageFlags.Ephemeral });
      }
      logger.info(`Guild ${guildId}: theme preset ${name} by ${interaction.user.id}`);
      return replyWithPreview(interaction, guildId, `✅ Preset **${name}** applied.`);
    }

    if (sub === 'list') {
      const overrides = getGuildOverrides(guildId);
      const palette = getGuildPalette(guildId);
      const lines = THEME_TOKENS.map(t => {
        const value = readToken(palette, t);
        const mark = overrides[t] ? ' ◀ set' : '';
        return `\`${value}\`  ${t.padEnd(14)} ${TOKEN_DESCRIPTIONS[t]}${mark}`;
      });
      const changed = Object.keys(overrides).length;
      return interaction.reply({
        content:
          `**Theme** · ${changed === 0 ? 'defaults' : `${changed} colour${changed === 1 ? '' : 's'} overridden`}\n` +
          '```\n' + lines.join('\n') + '\n```',
        flags: MessageFlags.Ephemeral,
      });
    }

    // show
    return replyWithPreview(interaction, guildId, undefined);
  },
};

/** Two sample cards under the guild's theme, so the admin sees the change they just made. */
async function replyWithPreview(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  content: string | undefined
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const division = getDivisionByChannel(guildId, interaction.channelId)?.division ?? 'B';
  // The handler already runs inside the guild's theme, but a `set` just changed it, so
  // re-enter with the fresh palette rather than the one this interaction started with.
  const preview = await withGuildTheme(guildId, () => renderThemePreview(interaction.client, division));
  await interaction.editReply({
    content,
    files: [
      new AttachmentBuilder(preview.queue, { name: 'theme_queue.png' }),
      new AttachmentBuilder(preview.result, { name: 'theme_result.png' }),
    ],
  });
}
