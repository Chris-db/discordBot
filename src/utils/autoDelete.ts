import { Interaction } from 'discord.js';

/**
 * Deletes an interaction's reply `delayMs` after the reply is actually *sent*.
 *
 * "Sent" means `interaction.replied`, which discord.js sets on reply() and editReply(),
 * not on deferReply(). The countdown used to start on deferral, so a handler that
 * deferred, did more than `delayMs` of work (a vote that finalises and sets up the next
 * phase inline -- one click does all of that in a bot lobby) and then called editReply
 * found its reply already deleted: DiscordAPIError 10008 Unknown Message on every such
 * click on a slow evening. Now the timer cannot start before there is a message to time.
 *
 * Gives up quietly if nothing is ever sent; silently ignores a reply already dismissed.
 */
export function autoDeleteReply(interaction: Interaction, delayMs: number = 5000): void {
  const maxWaitMs = 60_000;
  const pollInterval = 200;
  let waited = 0;

  const poller = setInterval(() => {
    waited += pollInterval;

    const sent = interaction.isRepliable() && interaction.replied;
    if (sent || waited >= maxWaitMs) {
      clearInterval(poller);
      if (sent) {
        setTimeout(() => {
          if (interaction.isRepliable()) {
            interaction.deleteReply().catch(() => {});
          }
        }, delayMs);
      }
    }
  }, pollInterval);
}
