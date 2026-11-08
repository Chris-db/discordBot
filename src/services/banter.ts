import { Client, Events, Message } from 'discord.js';
import { logger } from '../utils/logger';

/**
 * Gives the bot a personality: @ it and it answers with a dry, oblivious, hardcoded line.
 * Now and then it asks someone for their Epic display name and says "nice" to
 * whatever they type next.
 *
 * This is a joke that is expected to get old, so it is built to be thrown away. To remove
 * it, delete this file and tests/banter.test.ts, then remove `startBanter` from index.ts.
 * Nothing else depends on it and it keeps nothing in the database.
 */

// To change what the bot says, edit these lists. Lowercase and no punctuation is the voice.
export const LINES = {
  joke: [
    'my friend got a new car now he has a car',
    'i know a joke but its long and not very good',
    'two cars are in a parking lot thats the whole joke they are parked',
    'i had a joke about boost but i used it all',
    'why should you never eat a clock. its too time consuming',
    'you can bring a horse to the water but you cant water the horse',
    'i broke my finger last week. on the other hand im okay',
    'two windmills are standing on a wind farm. one asks "whats your favourite type of music" the other says "im a big metal fan"',
    'who me',
    'early worm gets the bird',
    'erm excuse me what the sigma',
    'those who know',
    'teacher: paint today hey finger class today we\nnamed paint kid',
  ],
  thanks: [
    'ok',
    'for what',
    'sure',
    'i didnt do anything',
    'you are welcome i guess',
    'ok pal',
    'who me',
  ],
  question: [
    'i dunno',
    'idk',
    'you could have asked anyone',
    'good question',
    'no idea',
    'not sure',
    'ask me something else',
    'maybe',
    'i was hoping you knew',
    'probably',
    'couldnt tell you',
    'i forgot the question',
    'who me',
  ],
  plain: [
    'who me',
    'who me',
    'sorry i wasnt listening',
    'yes',
    'wrong bot probably',
    'i was asleep',
    'did someone say something',
    'you have the wrong guy',
    'who me',
    'mb',
    'im busy doing nothing',
    'who me',
    'who me',
    'who me',
    'who me',
    'who me',
  ],
  trollAsk: [
    'whats your epic display name',
    'hey whats your epic display name',
    'quick question whats your epic display name',
  ],
  trollPayoff: [
    'nice',
    'nice one',
    'very nice',
  ],
  // Someone asks the bot "who me" and it points the finger back with a GIF. These are the
  // direct .gif files behind Klipy pages, because Discord shows a bare image link as just
  // the GIF, where a page link would add a "KLIPY: ..." title card. To add one, open the
  // Klipy page's source and take the og:image whose type is image/gif.
  whoMe: [
    // https://klipy.com/gifs/jerry-meme-tom-and-jerry-meme
    'https://static2.klipy.com/ii/925f17378dd1893b674a723c07535afe/94/9c/zCfoJNjx.gif',
    // https://klipy.com/gifs/get-a-load-of-this-pointing
    'https://static2.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/ff/bb/140xLj2juA22K4TCdJ.gif',
    // https://klipy.com/gifs/ishowspeed-this-guy
    'https://static2.klipy.com/ii/925f17378dd1893b674a723c07535afe/91/25/TWkhXjyD.gif',
  ],
};

const COOLDOWN_MS = 15_000;
const TROLL_CHANCE = 1 / 15;
const TROLL_REST_MS = 7 * 24 * 60 * 60_000;
const TROLL_ANSWER_WINDOW_MS = 2 * 60_000;

type LineCategory = 'whoMe' | 'joke' | 'thanks' | 'question' | 'plain';

/**
 * Picks which list a ping answers from. "who me" wins over everything, since it would
 * otherwise read as a question, and then a joke request, so "tell me a joke?" gets one.
 */
export function categorize(content: string): LineCategory {
  const text = content.replace(/<@[!&]?\d+>/g, '').trim().toLowerCase();
  if (/\bwho\W*me\b/.test(text)) return 'whoMe';
  if (/\bjokes?\b/.test(text)) return 'joke';
  if (/\b(thanks|thank you|thx|ty|good bot)\b/.test(text)) return 'thanks';
  if (
    text.includes('?') ||
    /^(what|whats|why|how|who|whos|when|where|wheres|which|is|are|am|can|could|do|does|did|will|would|should)\b/.test(text)
  ) {
    return 'question';
  }
  return 'plain';
}

/**
 * Builds the message handler. All its state lives in memory on purpose: a restart forgets
 * who was trolled, which costs nothing, and the feature leaves no table behind when it goes.
 */
export function createBanterHandler(
  random: () => number = Math.random,
  now: () => number = Date.now
): (message: Message) => Promise<void> {
  const nextReplyAt = new Map<string, number>();
  const trollRestUntil = new Map<string, number>();
  const awaitingAnswerUntil = new Map<string, number>();

  const pick = (lines: string[]) => lines[Math.floor(random() * lines.length)];

  return async message => {
    if (message.author.bot || !message.guildId) return;

    const personKey = `${message.guildId}:${message.author.id}`;
    const answerKey = `${message.channelId}:${message.author.id}`;

    // Without the MessageContent intent we can't read an answer that doesn't @ the bot, but
    // we are told that a message arrived. The payoff doesn't need the words, so any next
    // message counts as the answer.
    const answerDeadline = awaitingAnswerUntil.get(answerKey);
    if (answerDeadline !== undefined) {
      awaitingAnswerUntil.delete(answerKey);
      if (now() <= answerDeadline) {
        nextReplyAt.set(personKey, now() + COOLDOWN_MS);
        await replyQuietly(message, pick(LINES.trollPayoff));
        return;
      }
    }

    // mentions.users holds only direct @s of a user, so @everyone and role pings stay out.
    const botId = message.client.user?.id;
    if (!botId || !message.mentions.users.has(botId)) return;

    if (now() < (nextReplyAt.get(personKey) ?? 0)) return;
    nextReplyAt.set(personKey, now() + COOLDOWN_MS);

    const category = categorize(message.content);
    const canTroll = now() >= (trollRestUntil.get(personKey) ?? 0);
    if (category === 'plain' && canTroll && random() < TROLL_CHANCE) {
      const asked = await replyQuietly(message, pick(LINES.trollAsk));
      if (asked) {
        trollRestUntil.set(personKey, now() + TROLL_REST_MS);
        awaitingAnswerUntil.set(answerKey, now() + TROLL_ANSWER_WINDOW_MS);
      }
      return;
    }

    await replyQuietly(message, pick(LINES[category]));
  };
}

/**
 * Replies without notifying anyone: nobody needs a ping just to be told "idk".
 *
 * This sends straight away, ahead of the 1200 ms panel re-post that the same message sets
 * off in a queue channel, which is what keeps the reply above the panel rather than below.
 *
 * A failure is a warn, not an error, because every logger.error opens a GitHub issue and a
 * channel the bot can't post in isn't worth one.
 */
async function replyQuietly(message: Message, content: string): Promise<boolean> {
  try {
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
    return true;
  } catch (error) {
    logger.warn(`Could not send banter in channel ${message.channelId}:`, error);
    return false;
  }
}

export function startBanter(client: Client): void {
  const handle = createBanterHandler();
  client.on(Events.MessageCreate, message => {
    void handle(message);
  });
}
