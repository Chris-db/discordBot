import { Interaction } from 'discord.js';

/**
 * Automatically deletes an interaction reply after a specified delay in milliseconds (default: 5000ms / 5s).
 * Waits until the interaction has actually been replied to before starting the countdown,
 * so async deferReply/editReply work doesn't race against the timer.
 * Silently catches any errors if the reply was already deleted or dismissed.
 */
export function autoDeleteReply(interaction: Interaction, delayMs: number = 5000): void {
  const maxWaitMs = 30_000; // give up waiting after 30s
  const pollInterval = 200;
  let waited = 0;

  const poller = setInterval(() => {
    waited += pollInterval;

    const hasReply = interaction.isRepliable() && (interaction.replied || interaction.deferred);
    if (hasReply || waited >= maxWaitMs) {
      clearInterval(poller);
      if (hasReply) {
        setTimeout(() => {
          if (interaction.isRepliable()) {
            interaction.deleteReply().catch(() => {});
          }
        }, delayMs);
      }
    }
  }, pollInterval);
}
