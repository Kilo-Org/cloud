import { Effect, Layer, Stream } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The line a chat keeps.
 *
 * The composer stays open while the model works, so a person can ask twice
 * before the first answer lands. What that costs — a second read of one
 * session, a question asked on a model the person had already changed, a
 * question asked of a session that is closing — is what these cover. The SDK
 * is faked because none of it is about the SDK: it is about what this app does
 * with one question at a time.
 */

type Asked = { readonly sessionId: string; readonly text: string };

const asked: Asked[] = [];
/** What the session was opened with, so the tools it offers can be read back. */
let openedWith: { readonly tools?: readonly string[] } | undefined = undefined;
/** Ends the answer that is arriving, so a test decides when a turn finishes. */
let finish: (() => void) | undefined = undefined;

const handleFor = (id: string) => ({
  id,
  ask: (text: string) =>
    Stream.asyncPush<{ kind: 'delta'; text: string }>(emit =>
      Effect.sync(() => {
        asked.push({ sessionId: id, text });
        emit.single({ kind: 'delta', text: 'ok' });
        finish = () => {
          emit.end();
        };
        return Effect.void;
      })
    ),
  history: Effect.succeed([]),
});

vi.mock('@kilocode/harness-sdk', () => ({
  openSession: (options: { readonly tools?: readonly string[] }) => {
    openedWith = options;
    return Effect.succeed(handleFor('s1'));
  },
  continueSession: (id: string) => Effect.succeed(handleFor(id)),
  cloneSession: () => Effect.succeed(handleFor('s2')),
}));
vi.mock('./layers', () => ({ chatLayers: () => Layer.empty }));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: async () => {
    await Promise.resolve();
    return {};
  },
}));
vi.mock('./pending', () => ({
  askedIn: async () => {
    await Promise.resolve();
    return null;
  },
  forgetAsked: async () => {
    await Promise.resolve();
  },
  moveAsked: async () => {
    await Promise.resolve();
  },
  rememberAsked: async () => {
    await Promise.resolve();
  },
}));
vi.mock('./store', () => ({
  forgetSession: () => undefined,
  modelOfSession: () => 'kilo/one',
  moveChat: () => undefined,
  rememberChat: () => undefined,
  touchChat: () => undefined,
}));

const { enterChat, releaseChat, say, startChat, stopChat } = await import('./registry');
const { snapshotOf } = await import('./state');

const place = { chatScope: 'me:personal', org: { kind: 'personal' } } as const;

/** Lets the forked reading fiber run to wherever it gets to. */
const settled = async () => {
  for (let round = 0; round < 20; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- each turn of the loop hands the fiber another tick
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  }
};

let opened = '';

beforeEach(async () => {
  asked.length = 0;
  finish = undefined;
  opened = await startChat(place, 'kilo/one');
  await settled();
});

describe('what a chat is opened with', () => {
  it('offers the clock, because a model has none and answers from a stale date', () => {
    expect(openedWith?.tools).toEqual(['time']);
  });
});

describe('a second question while the first is being answered', () => {
  it('waits rather than starting a second read of the session', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/one');
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first']);
    expect(snapshotOf(opened).waiting).toEqual(['second']);
  });

  it('is asked when the answer lands, on the model it was sent with', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/two');
    await settled();

    finish?.();
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first', 'second']);
    // The move onto kilo/two is what makes the clone the session to carry on
    // with: the question is asked of the model that was on screen when it was
    // typed, not of the one the session happened to be on.
    expect(asked.at(-1)?.sessionId).toBe('s2');
    expect(snapshotOf('s2').waiting).toEqual([]);
  });

  it('is asked when the person stops the answer, because they still asked it', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/one');
    await settled();

    await stopChat(opened);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first', 'second']);
  });

  it('goes with the chat when the chat is closed', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/one');
    await settled();

    await releaseChat(opened);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first']);
  });
});

describe('a chat that moved', () => {
  it('leaves the chat it moved off pointing at the one it became', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/two');
    await settled();

    finish?.();
    await settled();

    /* The queued question moved the conversation, and nobody handed the new
       identifier back to the screen. The chat it left says where it went, so a
       screen watching the old one follows without being told. */
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });
});

describe('a question asked before the session has opened', () => {
  it('waits for the open rather than vanishing', async () => {
    await releaseChat(opened);
    asked.length = 0;

    /* No await: this is a person typing while the screen is still opening the
       chat, which is exactly the window the question used to be dropped in. */
    const entering = enterChat(place, 'later');
    await say('later', 'typed early', 'kilo/one');
    await entering;
    await settled();

    expect(asked).toEqual([{ sessionId: 'later', text: 'typed early' }]);
  });

  it('says so rather than reporting success when the chat is not there', async () => {
    await releaseChat(opened);
    asked.length = 0;

    await say(opened, 'into nothing', 'kilo/one');
    await settled();

    expect(asked).toEqual([]);
    /* The question is on screen with a Retry under it, which is what every
       other question that never reached the model gets. */
    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', asked: 'into nothing' });
    expect(snapshotOf(opened).failed).not.toBeNull();
  });
});
