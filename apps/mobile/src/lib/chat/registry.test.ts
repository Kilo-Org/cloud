/* eslint-disable max-lines -- the registry suite pins one question at a time, the moves onto another model or tool set, and the MCP discovery around an open on one fake SDK harness. */
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
 * with one question at a time. The Kilo MCP connection is faked for the same
 * reason: what is under test is what the registry does around a discovery, not
 * the discovery.
 */

type Asked = { readonly sessionId: string; readonly text: string };

const asked: Asked[] = [];
/** What the session was opened with, so the tools it offers can be read back. */
let openedWith: { readonly tools?: readonly string[] } | undefined = undefined;
/** What a clone was moved onto, so the tool set it names can be read back. */
let clonedWith: { readonly tools?: readonly string[]; readonly model?: string } | undefined =
  undefined;
/** Ends the answer that is arriving, so a test decides when a turn finishes. */
let finish: (() => void) | undefined = undefined;
/** A session id whose reopen fails, so the failed-open path can be exercised. */
let failOpenFor: string | undefined = undefined;
/** A session id whose stored tool names no longer resolve, so the mover can be. */
let missingToolsFor: string | undefined = undefined;
/** A session id whose stored names no longer resolve when it is cloned onto. */
let missingCloneFor: string | undefined = undefined;
/** A session id whose history read fails, so the half-open path can be exercised. */
let failHistoryFor: string | undefined = undefined;
/** Every session whose scope was closed, so a leaked one can be told from one released. */
const released: string[] = [];

/**
 * The Kilo MCP connection, faked the way the plugin is: what is under test is
 * what the registry does around discovery, not the discovery itself.
 */
const mcp = vi.hoisted(() => ({
  tools: [] as { readonly definition: { readonly name: string } }[],
  /** The per-chat setting, absent meaning on. */
  enabled: new Map<string, boolean>(),
  ensure: vi.fn(async () => {
    await Promise.resolve();
    return {
      status: 'ready' as const,
      tools: [] as { readonly definition: { readonly name: string } }[],
    };
  }),
}));

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
  history:
    failHistoryFor === id ? Effect.fail(new Error('history unreadable')) : Effect.succeed([TURN]),
});

/** Opens a session that is released when the scope holding it closes. */
const openInScope = (id: string) =>
  Effect.acquireRelease(Effect.succeed(handleFor(id)), () =>
    Effect.sync(() => {
      released.push(id);
    })
  );

vi.mock('@kilocode/harness-sdk', () => {
  /** The name a session was stored with that the registry no longer holds. */
  class FakeToolMissingError extends Error {
    constructor() {
      super('the session names a tool the registry does not hold');
      this.name = 'ToolMissingError';
    }
  }
  return {
    ToolMissingError: FakeToolMissingError,
    openSession: (options: { readonly tools?: readonly string[] }) => {
      openedWith = options;
      return Effect.succeed(handleFor('s1'));
    },
    continueSession: (id: string) => {
      if (failOpenFor === id) {
        return openInScope(id).pipe(Effect.andThen(Effect.fail(new Error('no such session'))));
      }
      if (missingToolsFor === id) {
        return Effect.fail(new FakeToolMissingError());
      }
      return openInScope(id);
    },
    cloneSession: (
      id: string,
      onto: { readonly tools?: readonly string[]; readonly model?: string } | undefined
    ) => {
      clonedWith = onto;
      /* A clone that names no tools keeps the stored set, so it is the one that
         fails when the registry no longer holds those names. */
      if (missingCloneFor === id && onto?.tools === undefined) {
        return Effect.fail(new FakeToolMissingError());
      }
      return Effect.succeed(handleFor('s2'));
    },
  };
});
vi.mock('./layers', () => ({ chatLayers: () => Layer.empty }));
vi.mock('@/lib/config', () => ({ KILO_MCP_URL: 'https://mcp.example' }));
vi.mock('./kilo-mcp', () => ({
  ensureKiloMcp: mcp.ensure,
  mcpEnabledFor: async (sessionId: string) => {
    await Promise.resolve();
    return mcp.enabled.get(sessionId) ?? true;
  },
  setMcpEnabled: async (sessionId: string, enabled: boolean) => {
    await Promise.resolve();
    if (enabled) {
      mcp.enabled.delete(sessionId);
      return;
    }
    mcp.enabled.set(sessionId, false);
  },
  moveMcpEnabled: async (from: string, to: string) => {
    await Promise.resolve();
    const held = mcp.enabled.get(from);
    mcp.enabled.delete(from);
    if (held === undefined) {
      mcp.enabled.delete(to);
      return;
    }
    mcp.enabled.set(to, held);
  },
  kiloMcpTools: () => mcp.tools,
  kiloMcpToolNames: () => mcp.tools.map(tool => tool.definition.name),
}));
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

const { enterChat, releaseChat, retryKiloMcp, say, setMcpEnabled, startChat, stopChat } =
  await import('./registry');
const { change, snapshotOf } = await import('./state');
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
  /* A test that moved a chat leaves its old id pointing at the new session;
     releasing it clears the pointer so the next test's `s1` starts fresh. */
  if (opened !== '') {
    await releaseChat(opened);
  }
  asked.length = 0;
  released.length = 0;
  finish = undefined;
  failOpenFor = undefined;
  missingToolsFor = undefined;
  missingCloneFor = undefined;
  failHistoryFor = undefined;
  clonedWith = undefined;
  openedWith = undefined;
  mcp.tools.length = 0;
  mcp.enabled.clear();
  opened = await startChat(place, 'kilo/one');
  await settled();
  /* Cleared after the chat above, so a test counts only its own discoveries. */
  mcp.ensure.mockClear();
});

describe('what a chat is opened with', () => {
  it('offers the clock, because a model has none and answers from a stale date', () => {
    expect(openedWith?.tools).toEqual(['time']);
  });
});

describe('the Kilo MCP tools a chat is opened with', () => {
  /** The one tool the fake server offers, named the way the harness names it. */
  const discovered = { definition: { name: 'mcp_kilo_read-file' } };

  it('opens a new chat on the server tools once they are discovered', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);

    opened = await startChat(place, 'kilo/one');
    await settled();

    /* The open asks for the automatic deadline, so a slow server leaves the
       chat opening rather than holding the send on it. */
    expect(mcp.ensure).toHaveBeenCalledWith(place, 'automatic');
    expect(openedWith?.tools).toEqual(['time', 'mcp_kilo_read-file']);
  });

  it('opens a chat with the setting off on the clock alone, and reaches no server', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);

    opened = await startChat(place, 'kilo/one', false);
    await settled();

    expect(openedWith?.tools).toEqual(['time']);
    expect(mcp.ensure).not.toHaveBeenCalled();
  });

  it('reaches the server when the setting is turned on for a chat that never discovered', async () => {
    /* The chat was opened with the setting off, so no discovery ran and the
       connection is idle. Turning it on has to ask the server: without that the
       chat is moved onto the base tools, the view stays "not available", and
       the switch the person just turned on snaps back off. */
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, 'kilo/one', false);
    await settled();
    expect(mcp.ensure).not.toHaveBeenCalled();

    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: mcp.tools });
    await setMcpEnabled(opened, true);
    await settled();

    expect(mcp.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ chatScope: 'me:personal' }),
      'automatic'
    );
    expect(clonedWith).toEqual({ tools: ['time', 'mcp_kilo_read-file'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('moves an idle chat off the server tools when the setting is turned off', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, 'kilo/one');
    await settled();
    expect(snapshotOf(opened).sessionId).toBe('s1');

    await setMcpEnabled(opened, false);
    await settled();

    /* The tool set is frozen for the life of a session, so turning it off is a
       copy onto a session without those tools, and the setting follows it. */
    expect(clonedWith).toEqual({ tools: ['time'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
    expect(mcp.enabled.get('s2')).toBe(false);
  });

  it('applies a choice made while an answer was arriving once it settles', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, 'kilo/one');
    await settled();
    await say(opened, 'first', 'kilo/one');
    await settled();

    await setMcpEnabled(opened, false);
    await settled();

    /* Never under an answer that is still coming: the chat has not moved. */
    expect(clonedWith).toBeUndefined();
    expect(snapshotOf(opened).sessionId).toBe('s1');

    finish?.();
    await settled();

    expect(clonedWith).toEqual({ tools: ['time'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('opens a stored chat whose tool names no longer resolve, on the names now held', async () => {
    mcp.tools.push(discovered);
    missingToolsFor = 'stale';

    await enterChat(place, 'stale');
    await settled();

    /* The server's list moved on, or it is down while the session was stored
       with its tools. The chat opens either way rather than failing on a name
       nothing holds. */
    expect(clonedWith).toEqual({ tools: ['time', 'mcp_kilo_read-file'] });
    expect(snapshotOf('stale').status).toBe('idle');
    expect(snapshotOf('stale').failed).toBeNull();

    /* The chat it opened is released here, so the session it moved onto does
       not outlive the test that made it. */
    await releaseChat('stale');
  });

  it('moves onto another model on the names it holds when the stored ones no longer resolve', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, 'kilo/one');
    await settled();
    expect(openedWith?.tools).toEqual(['time', 'mcp_kilo_read-file']);

    /* A call that did not reach the server dropped the tools from the registry,
       so the session is stored naming one nothing holds. Switching the model
       must still move the chat rather than report the send as failed. */
    mcp.tools.length = 0;
    missingCloneFor = opened;

    await say(opened, 'second', 'kilo/two');
    await settled();

    expect(clonedWith).toEqual({ model: 'kilo/two', tools: ['time'] });
    expect(snapshotOf(opened).failed).toBeNull();
    expect(snapshotOf(opened).sessionId).toBe('s2');
    expect(asked.at(-1)).toEqual({ sessionId: 's2', text: 'second' });
  });

  it('retries a failed discovery and moves the chat onto the tools that answered', async () => {
    /* The chat opened while the server was down, so it named the clock alone.
       The retry finds the server, and the session is frozen on what it was
       opened with, so the recovered tools need a session that names them. */
    await releaseChat(opened);
    opened = await startChat(place, 'kilo/one');
    await settled();
    expect(openedWith?.tools).toEqual(['time']);

    mcp.tools.push(discovered);
    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: mcp.tools });
    await retryKiloMcp(opened);
    await settled();

    expect(mcp.ensure).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatScope: 'me:personal' }),
      'retry'
    );
    expect(clonedWith).toEqual({ tools: ['time', 'mcp_kilo_read-file'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('leaves the chat where it is when the retry still finds no tools', async () => {
    await releaseChat(opened);
    opened = await startChat(place, 'kilo/one');
    await settled();
    clonedWith = undefined;

    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: [] });
    await retryKiloMcp(opened);
    await settled();

    expect(clonedWith).toBeUndefined();
    expect(snapshotOf(opened).sessionId).toBe('s1');
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

  it('keeps the transcript on screen while the screen follows the chat it became', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/two');
    await settled();

    finish?.();
    await settled();

    /* Reading the id the chat moved off resolves to the session that carried
       on, so the transcript is never cleared between the move and the screen
       following, and the moved chat is not copied under the old id. */
    expect(snapshotOf(opened)).toBe(snapshotOf('s2'));
    expect(snapshotOf(opened).turns).toEqual([TURN]);
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('follows a route still naming the moved-off id instead of failing on it', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/two');
    await settled();

    finish?.();
    await settled();

    /* The route keeps the id the chat was opened on. Opening it must follow to
       the chat that carried on, not reopen the session the move deleted and
       report its failure onto the live chat. */
    failOpenFor = opened;
    await enterChat(place, opened);

    expect(snapshotOf('s2').failed).toBeNull();
    expect(snapshotOf('s2').sessionId).toBe('s2');
  });

  it('ends the chat it points at when the id it moved off is released', async () => {
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', 'kilo/two');
    await settled();

    finish?.();
    await settled();

    /* A route or a list row can still name the id the chat moved off. Releasing
       it ends the chat it became. Both halves are read here: the live chat is
       gone, and the old id no longer points at it. Left running, the session
       answers under a screen that let it go; left pointing, the next reader of
       the old id finds a chat that is gone. */
    await releaseChat(opened);

    expect(snapshotOf('s2').status).toBe('opening');
    expect(snapshotOf(opened).sessionId).toBe(opened);
  });
});

describe('a chat that could not be opened', () => {
  it('settles idle with the reason instead of staying on opening', async () => {
    failOpenFor = 'missing';

    await enterChat(place, 'missing');

    expect(snapshotOf('missing').status).toBe('idle');
    expect(snapshotOf('missing').failed).toContain('no such session');
  });

  it('closes the scope it opened rather than leaking the session', async () => {
    failOpenFor = 'missing';

    await enterChat(place, 'missing');

    /* The open failed after the scope was made; with nothing holding it, only
       closing it runs the finalizers the half-open session registered. */
    expect(released).toContain('missing');
  });

  it('closes the scope when the history cannot be read', async () => {
    failHistoryFor = 'unreadable';

    await enterChat(place, 'unreadable');

    expect(snapshotOf('unreadable').status).toBe('idle');
    expect(released).toContain('unreadable');
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
