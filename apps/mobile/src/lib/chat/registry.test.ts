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
/** A session id whose reopen fails, so the failed-open path can be exercised. */
let failOpenFor: string | undefined = undefined;

/** One stored turn, so a state that still holds turns can be told from an empty one. */
const TURN = {
  id: 'trn_1',
  sessionId: 's1',
  role: 'user',
  parts: [{ id: 'prt_1', kind: 'text', body: 'hi' }],
} as const;

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
  history: Effect.succeed([TURN]),
});

vi.mock('@kilocode/harness-sdk', () => ({
  openSession: (options: { readonly tools?: readonly string[] }) => {
    openedWith = options;
    return Effect.succeed(handleFor('s1'));
  },
  continueSession: (id: string) =>
    failOpenFor === id ? Effect.fail(new Error('no such session')) : Effect.succeed(handleFor(id)),
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
const { change, NOTHING, snapshotOf } = await import('./state');
const { chatPlaceOf } = await import('./use-chat');

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
  failOpenFor = undefined;
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

  it('moves the turns with the chat rather than keeping a copy on the one it left', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/two');
    await settled();

    finish?.();
    await settled();

    /* The pointer is all the old chat keeps. A second copy of its turns would
       leak one conversation per model switch, and the copy would then go stale
       against the session that actually carried them. */
    expect(snapshotOf(opened).sessionId).toBe('s2');
    expect(snapshotOf(opened).turns).toBe(NOTHING.turns);
    expect(snapshotOf('s2').turns).toEqual([TURN]);
  });
});

describe('a chat that could not be opened', () => {
  it('settles idle with the reason instead of staying on opening', async () => {
    failOpenFor = 'missing';

    await enterChat(place, 'missing');

    expect(snapshotOf('missing').status).toBe('idle');
    expect(snapshotOf('missing').failed).toContain('no such session');
  });
});

describe('deleting a chat that was never opened', () => {
  it('forgets the state the row left behind', async () => {
    change('never-opened', { status: 'working' });
    expect(snapshotOf('never-opened').status).toBe('working');

    await releaseChat('never-opened');

    /* Forgotten: the next read starts a fresh state rather than the stale one. */
    expect(snapshotOf('never-opened').status).toBe('opening');
  });
});

describe('where a chat belongs', () => {
  it('answers the same object for the same account and organization', () => {
    /* A screen reads this on every render; a fresh object would re-run the
       open effect each time and reopen a chat a model switch just moved. */
    expect(chatPlaceOf('user-1', null)).toBe(chatPlaceOf('user-1', null));
    expect(chatPlaceOf('user-1', 'org-1')).toBe(chatPlaceOf('user-1', 'org-1'));
  });

  it('keeps scopes apart and answers nothing without a user', () => {
    expect(chatPlaceOf('user-1', null)).not.toBe(chatPlaceOf('user-2', null));
    expect(chatPlaceOf('user-1', null)?.chatScope).toBe('user-1:personal');
    expect(chatPlaceOf('user-1', 'org-1')?.chatScope).toBe('user-1:org-1');
    expect(chatPlaceOf(null, null)).toBeNull();
    expect(chatPlaceOf('', 'org-1')).toBeNull();
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
