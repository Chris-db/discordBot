import { describe, it, expect, vi } from 'vitest';
import { categorize, createBanterHandler, LINES } from '../src/services/banter';

const BOT_ID = '999';
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** A message as the gateway delivers it. A message that doesn't @ the bot arrives with no text. */
function fakeMessage(
  overrides: { pinged?: boolean; userId?: string; channelId?: string; content?: string; bot?: boolean; guildId?: string | null } = {}
) {
  const { pinged = true, userId = '1', channelId = 'c1', content = '', bot = false, guildId = 'g1' } = overrides;
  const reply = vi.fn().mockResolvedValue({});
  const message = {
    author: { id: userId, bot },
    guildId,
    channelId,
    content: pinged ? `<@${BOT_ID}> ${content}` : '',
    client: { user: { id: BOT_ID } },
    mentions: { users: new Map(pinged ? [[BOT_ID, {}]] : []) },
    reply,
  } as any;
  return { message, reply };
}

function sentText(reply: ReturnType<typeof vi.fn>): string {
  return reply.mock.calls[0][0].content;
}

/** A handler on a hand-cranked clock. Random defaults to "never troll, first line". */
function harness(randomValues: number[] = []) {
  const clock = { time: 1_000_000 };
  const random = () => randomValues.shift() ?? 0.99;
  return { handle: createBanterHandler(random, () => clock.time), clock };
}

/** Random values that trigger the troll: the 1-in-15 roll, then which question to ask. */
const TROLL = [0, 0];

describe('categorize', () => {
  it.each([
    ['tell me a joke', 'joke'],
    ['tell me a joke?', 'joke'],
    ['thanks', 'thanks'],
    ['good bot', 'thanks'],
    ['you there?', 'question'],
    ['what is the time', 'question'],
    ['who me', 'whoMe'],
    ['who me?', 'whoMe'],
    ['Who, me?', 'whoMe'],
    ['wait who me lol', 'whoMe'],
    ['who meant this', 'question'],
    ['hello', 'plain'],
    ['', 'plain'],
    ['the show is good', 'plain'],
  ])('%j is a %s', (content, expected) => {
    expect(categorize(`<@${BOT_ID}> ${content}`)).toBe(expected);
  });
});

describe('who gets a reply', () => {
  it('replies from the matching list without pinging anyone', async () => {
    const { handle } = harness();
    const { message, reply } = fakeMessage({ content: 'why' });
    await handle(message);
    expect(LINES.question).toContain(sentText(reply));
    expect(reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('answers "who me" with one of the GIFs, and never with the Epic name troll', async () => {
    const { handle } = harness([...TROLL]);
    const { message, reply } = fakeMessage({ content: 'who me?' });
    await handle(message);
    expect(LINES.whoMe).toContain(sentText(reply));
    expect(sentText(reply)).toMatch(/^https:\/\/\S+\.gif$/);
  });

  it('ignores messages that do not @ the bot, which covers @everyone and role pings', async () => {
    const { handle } = harness();
    const { message, reply } = fakeMessage({ pinged: false });
    await handle(message);
    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores other bots and anything outside a server', async () => {
    const { handle } = harness();
    const fromBot = fakeMessage({ bot: true });
    const fromDm = fakeMessage({ guildId: null });
    await handle(fromBot.message);
    await handle(fromDm.message);
    expect(fromBot.reply).not.toHaveBeenCalled();
    expect(fromDm.reply).not.toHaveBeenCalled();
  });

  it('answers each person once per 15 seconds, without holding up anyone else', async () => {
    const { handle, clock } = harness();
    const first = fakeMessage();
    const tooSoon = fakeMessage();
    const someoneElse = fakeMessage({ userId: '2' });
    const later = fakeMessage();

    await handle(first.message);
    clock.time += 14_999;
    await handle(tooSoon.message);
    await handle(someoneElse.message);
    clock.time += 1;
    await handle(later.message);

    expect(first.reply).toHaveBeenCalledOnce();
    expect(tooSoon.reply).not.toHaveBeenCalled();
    expect(someoneElse.reply).toHaveBeenCalledOnce();
    expect(later.reply).toHaveBeenCalledOnce();
  });

  it('survives a channel it cannot post in', async () => {
    const { handle } = harness();
    const { message, reply } = fakeMessage();
    reply.mockRejectedValue(new Error('Missing Permissions'));
    await expect(handle(message)).resolves.toBeUndefined();
  });
});

describe('the Epic name troll', () => {
  it('asks on a plain ping and calls the next message good, even one it cannot read', async () => {
    const { handle } = harness([...TROLL]);
    const ping = fakeMessage();
    const answer = fakeMessage({ pinged: false });

    await handle(ping.message);
    await handle(answer.message);

    expect(LINES.trollAsk).toContain(sentText(ping.reply));
    expect(LINES.trollPayoff).toContain(sentText(answer.reply));
  });

  it('never fires on a question or a joke request', async () => {
    const { handle } = harness([0, 0]);
    const { message, reply } = fakeMessage({ content: 'why' });
    await handle(message);
    expect(LINES.question).toContain(sentText(reply));
  });

  it('pays off once, and only for that person in that channel', async () => {
    const { handle } = harness([...TROLL]);
    const otherPerson = fakeMessage({ pinged: false, userId: '2' });
    const otherChannel = fakeMessage({ pinged: false, channelId: 'c2' });
    const answer = fakeMessage({ pinged: false });
    const afterwards = fakeMessage({ pinged: false });

    await handle(fakeMessage().message);
    await handle(otherPerson.message);
    await handle(otherChannel.message);
    await handle(answer.message);
    await handle(afterwards.message);

    expect(otherPerson.reply).not.toHaveBeenCalled();
    expect(otherChannel.reply).not.toHaveBeenCalled();
    expect(answer.reply).toHaveBeenCalledOnce();
    expect(afterwards.reply).not.toHaveBeenCalled();
  });

  it('counts a second @ as the answer, rather than replying to it twice', async () => {
    const { handle } = harness([...TROLL]);
    const answer = fakeMessage({ content: 'who wants to know' });

    await handle(fakeMessage().message);
    await handle(answer.message);

    expect(answer.reply).toHaveBeenCalledOnce();
    expect(LINES.trollPayoff).toContain(sentText(answer.reply));
  });

  it('gives up after two minutes', async () => {
    const { handle, clock } = harness([...TROLL]);
    const tooLate = fakeMessage({ pinged: false });

    await handle(fakeMessage().message);
    clock.time += 2 * 60_000 + 1;
    await handle(tooLate.message);

    expect(tooLate.reply).not.toHaveBeenCalled();
  });

  it('leaves the person alone for a week, then can catch them again', async () => {
    const { handle, clock } = harness([...TROLL, 0, 0, ...TROLL]);
    await handle(fakeMessage().message);
    await handle(fakeMessage({ pinged: false }).message);

    clock.time += WEEK_MS - 60_000;
    const stillResting = fakeMessage();
    await handle(stillResting.message);
    expect(LINES.plain).toContain(sentText(stillResting.reply));

    clock.time += 60_000;
    const caughtAgain = fakeMessage();
    await handle(caughtAgain.message);
    expect(LINES.trollAsk).toContain(sentText(caughtAgain.reply));
  });

  it('does not wait for an answer when the question failed to send', async () => {
    const { handle } = harness([...TROLL]);
    const ping = fakeMessage();
    ping.reply.mockRejectedValue(new Error('Missing Permissions'));
    const next = fakeMessage({ pinged: false });

    await handle(ping.message);
    await handle(next.message);

    expect(next.reply).not.toHaveBeenCalled();
  });
});
