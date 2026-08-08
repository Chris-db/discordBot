import { ChatInputCommandInteraction, SlashCommandIntegerOption } from 'discord.js';
import { SUPPORTED_TEAM_SIZES, DEFAULT_TEAM_SIZE } from '../database/migrations';

/**
 * Shared plumbing for the `size` option that now appears on most commands.
 *
 * Each team size is its own ladder, so a command that shows or edits a rating has to say
 * which one it means. They all default to 3v3 -- the size everything was before
 * multi-queue, and still the usual one.
 */

/** "3v3". */
export function formatTeamSize(teamSize: number): string {
  return `${teamSize}v${teamSize}`;
}

export const TEAM_SIZE_CHOICES = SUPPORTED_TEAM_SIZES.map(size => ({
  name: formatTeamSize(size),
  value: size,
}));

/**
 * Structural, so it fits both a top-level SlashCommandBuilder and a subcommand builder --
 * both mutate in place and return themselves, which is why returning the original is safe.
 */
interface AcceptsIntegerOption {
  addIntegerOption(
    input: (builder: SlashCommandIntegerOption) => SlashCommandIntegerOption
  ): unknown;
}

/** Adds an optional `size` option, defaulting to 3v3 when omitted. */
export function addTeamSizeOption<T extends AcceptsIntegerOption>(
  builder: T,
  description = 'Which ladder (defaults to 3v3)'
): T {
  builder.addIntegerOption(opt =>
    opt.setName('size').setDescription(description).setRequired(false).addChoices(...TEAM_SIZE_CHOICES)
  );
  return builder;
}

/** Reads the `size` option, falling back to 3v3. */
export function getTeamSizeOption(interaction: ChatInputCommandInteraction): number {
  return interaction.options.getInteger('size') ?? DEFAULT_TEAM_SIZE;
}
