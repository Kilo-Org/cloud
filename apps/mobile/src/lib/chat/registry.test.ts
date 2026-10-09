/* eslint-disable max-lines -- the registry suite pins one question at a time, the moves onto another model or tool set, and the MCP discovery around an open on one fake SDK harness. */
import { Effect, Layer, Stream } from 'effect';
import { type StoredChatBackend } from './backend-store';
import { backendTargetId } from './backend-target';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

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
/**
 * What the store says a session was opened with, so a chat already on the names
 * can be told from one that has to move. Null is a session nothing wrote.
 */
let storedTools: readonly string[] | null = null;
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
/** A cleanup failure after a move installed its session, before onto returned. */
let failForgetFor: string | undefined = undefined;
let failAnswerFor: string | undefined = undefined;
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

const backendState = vi.hoisted(() => ({ profiles: [] as StoredChatBackend[] }));
vi.mock('./backend-store', () => ({
  listChatBackends: () => backendState.profiles,
  waitForChatBackends: async () => {
    await Promise.resolve();
  },
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
  ask: (text: string) => {
    if (failAnswerFor === id) {
      asked.push({ sessionId: id, text });
      return Stream.fail(new Error('custom answer failed'));
    }
    return Stream.asyncPush<{ kind: 'delta'; text: string }>(emit =>
      Effect.sync(() => {
        asked.push({ sessionId: id, text });
        emit.single({ kind: 'delta', text: 'ok' });
        finish = () => {
          emit.end();
        };
        return Effect.void;
      })
    );
  },
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
vi.mock('./layers', () => ({
  chatLayers: () => Layer.empty,
  /* The registry reads the chat's organization to give the settings tools their
     defaults context; the layer itself is replaced above. */
  organizationIdOf: (org: { readonly kind: string; readonly id?: string }) =>
    org.kind === 'organization' ? org.id : undefined,
}));
vi.mock('@/lib/config', () => ({ KILO_MCP_URL: 'https://mcp.example' }));

// The one group switch for the settings tools, so a test can move it and see
// the chat's names follow.
const settingsSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock('./settings-tools-switch', () => ({
  isSettingsToolsEnabled: () => settingsSwitch.enabled,
}));
vi.mock('@/lib/settings/registry', () => ({
  settingsService: () => ({ settings: [], read: () => undefined, write: () => undefined }),
}));
vi.mock('@/lib/settings/confirm', () => ({ confirmSettingChange: () => undefined }));
// The person's own remote servers; what is under test is the registry's use of
// the names, not the discovery.
const remote = vi.hoisted(() => ({
  tools: [] as { readonly definition: { readonly name: string } }[],
}));
vi.mock('./remote-mcp', () => ({
  remoteServerTools: () => remote.tools,
  remoteServerToolNames: () => remote.tools.map(tool => tool.definition.name),
}));
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
const storedQuestions = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: async () => {
    await Promise.resolve();
    return {};
  },
  getItem: async (scope: string, key: string) => {
    await Promise.resolve();
    return storedQuestions.get(`${scope}:${key}`) ?? null;
  },
  setItem: async (scope: string, key: string, value: string) => {
    await Promise.resolve();
    storedQuestions.set(`${scope}:${key}`, value);
  },
  removeItem: async (scope: string, key: string) => {
    await Promise.resolve();
    storedQuestions.delete(`${scope}:${key}`);
  },
}));
vi.mock('./store', () => ({
  forgetSession: (_database: unknown, sessionId: string) => {
    if (failForgetFor === sessionId) {
      failForgetFor = undefined;
      throw new Error('session cleanup failed after move');
    }
  },
  modelOfSession: () => 'kilo/one',
  moveChat: () => undefined,
  rememberChat: () => undefined,
  touchChat: () => undefined,
  toolsOfSession: () => storedTools,
}));

const {
  enterChat,
  refreshChatTools,
  releaseChat,
  retryChat,
  retryKiloMcp,
  say,
  setMcpEnabled,
  startChat,
  stopChat,
} = await import('./registry');
const { change, snapshotOf } = await import('./state');
const { chatPlaceOf } = await import('./use-chat');
const { askedIn, forgetAsked } = await import('./pending');

const place = { chatScope: 'me:personal', org: { kind: 'personal' } } as const;

/** The settings tools a chat is opened with while the group switch is on. */
const SETTINGS = ['settings_list', 'settings_set'];

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
  failForgetFor = undefined;
  failAnswerFor = undefined;
  storedQuestions.clear();
  clonedWith = undefined;
  openedWith = undefined;
  storedTools = null;
  settingsSwitch.enabled = true;
  mcp.tools.length = 0;
  mcp.enabled.clear();
  remote.tools.length = 0;
  backendState.profiles = [];
  opened = await startChat(place, 'kilo/one');
  await settled();
  /* Cleared after the chat above, so a test counts only its own discoveries. */
  mcp.ensure.mockClear();
});

describe('what a chat is opened with', () => {
  it('offers the clock, because a model has none and answers from a stale date', () => {
    expect(openedWith?.tools).toEqual(['time', ...SETTINGS]);
  });

  it('moves the open chat onto the names the group switch names now, at its next use', async () => {
    /* A session freezes its tools, so the switch moving changes what the next
       session would name and nothing about the one on screen. The chat is moved
       when it is next used, which is what sends the new list to the model. */
    expect(snapshotOf(opened).sessionId).toBe('s1');

    settingsSwitch.enabled = false;
    await refreshChatTools();
    await settled();

    /* The tap clones nothing: one switch moved one thing, and the chats this
       run has visited are not each copied for it. */
    expect(clonedWith).toBeUndefined();

    await say(opened, 'hello', 'kilo/one');
    await settled();

    expect(clonedWith).toEqual({ tools: ['time'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('drops the settings tools on the next question even if the chat was never marked', async () => {
    /* A chat that did not exist when the switch moved is not in the map to
       mark. The store still holds the names it was opened with, so the next
       question compares those with the switch as it stands now rather than
       offering a tool the person just took away. */
    storedTools = ['time', ...SETTINGS];
    settingsSwitch.enabled = false;
    await say(opened, 'hello', 'kilo/one');
    await settled();

    expect(clonedWith).toEqual({ tools: ['time'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('leaves a chat alone when the switch that moved was not its own', async () => {
    /* A server's flag flipping is not this chat's: it names none of that
       server's tools, so its set did not move and its session is not copied. */
    storedTools = ['time', ...SETTINGS];
    await refreshChatTools();
    await settled();

    await say(opened, 'hello', 'kilo/one');
    await settled();

    expect(clonedWith).toBeUndefined();
    expect(snapshotOf(opened).sessionId).toBe('s1');
    expect(asked.at(-1)).toEqual({ sessionId: 's1', text: 'hello' });
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
    expect(openedWith?.tools).toEqual(['time', ...SETTINGS, 'mcp_kilo_read-file']);
  });

  it('opens a chat with the setting off on the clock alone, and reaches no server', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);

    opened = await startChat(place, 'kilo/one', false);
    await settled();

    expect(openedWith?.tools).toEqual(['time', ...SETTINGS]);
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
    expect(clonedWith).toEqual({ tools: ['time', ...SETTINGS, 'mcp_kilo_read-file'] });
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
    expect(clonedWith).toEqual({ tools: ['time', ...SETTINGS] });
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

    expect(clonedWith).toEqual({ tools: ['time', ...SETTINGS] });
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
    expect(clonedWith).toEqual({ tools: ['time', ...SETTINGS, 'mcp_kilo_read-file'] });
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
    expect(openedWith?.tools).toEqual(['time', ...SETTINGS, 'mcp_kilo_read-file']);

    /* A call that did not reach the server dropped the tools from the registry,
       so the session is stored naming one nothing holds. Switching the model
       must still move the chat rather than report the send as failed. */
    mcp.tools.length = 0;
    missingCloneFor = opened;

    await say(opened, 'second', 'kilo/two');
    await settled();

    expect(clonedWith).toEqual({ model: 'kilo/two', tools: ['time', ...SETTINGS] });
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
    expect(openedWith?.tools).toEqual(['time', ...SETTINGS]);

    mcp.tools.push(discovered);
    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: mcp.tools });
    await retryKiloMcp(opened);
    await settled();

    expect(mcp.ensure).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatScope: 'me:personal' }),
      'retry'
    );
    expect(clonedWith).toEqual({ tools: ['time', ...SETTINGS, 'mcp_kilo_read-file'] });
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

  it('clears the safe failure once a later entry opens the chat', async () => {
    failHistoryFor = 'flaky';
    await enterChat(place, 'flaky');
    expect(snapshotOf('flaky').failureKey).toBe('common.somethingWentWrong');

    failHistoryFor = undefined;
    await enterChat(place, 'flaky');

    expect(snapshotOf('flaky')).toMatchObject({ status: 'idle', failureKey: null, turns: [TURN] });
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

describe('custom backend question targets', () => {
  const backend: StoredChatBackend = {
    id: 'custom-server',
    revision: 1,
    name: 'Custom',
    baseUrl: 'https://custom.example/v1',
    apiKind: 'chat_completions',
    apiKey: '',
    headers: {},
    models: [{ id: 'same-model', name: 'Model', tools: false }],
    allowLocalHttp: false,
  };

  it('drops all tool definitions when a queued question moves onto a text-only backend', async () => {
    backendState.profiles = [backend];
    storedTools = ['time', ...SETTINGS];
    const target = backendTargetId(backend, 'same-model');
    await say(opened, 'first', 'kilo/one');
    await settled();
    await say(opened, 'second', target);
    expect(snapshotOf(opened).waiting).toEqual(['second']);
    finish?.();
    await settled();
    expect(clonedWith).toEqual({ model: target, tools: [] });
    expect(snapshotOf(opened).model).toBe(target);
    expect(asked.at(-1)?.text).toBe('second');
  });

  it.each([
    ['deleted', 'modelChat.backends.deletedBackend'],
    ['edited', 'modelChat.backends.staleBackend'],
  ] as const)(
    'keeps a queued question on its original target after the backend is %s',
    async (mutation, errorKey) => {
      backendState.profiles = [backend];
      const target = backendTargetId(backend, 'same-model');
      await say(opened, 'first', 'kilo/one');
      await settled();
      await say(opened, 'custom question', target);
      expect(snapshotOf(opened).waiting).toEqual(['custom question']);

      backendState.profiles = mutation === 'deleted' ? [] : [{ ...backend, revision: 2 }];
      finish?.();
      await settled();

      expect(asked).toEqual([{ sessionId: 's1', text: 'first' }]);
      expect(clonedWith).toBeUndefined();
      expect(snapshotOf(opened)).toMatchObject({
        model: 'kilo/one',
        turns: [TURN],
        status: 'idle',
        asked: 'custom question',
        askedModel: target,
        waiting: [],
        failed: i18n.t(errorKey),
        failureKey: errorKey,
      });
      expect(await askedIn(opened)).toEqual({ text: 'custom question', model: target });

      await retryChat(opened);
      await settled();

      expect(asked).toEqual([{ sessionId: 's1', text: 'first' }]);
      expect(snapshotOf(opened)).toMatchObject({
        model: 'kilo/one',
        asked: 'custom question',
        askedModel: target,
        failed: i18n.t(errorKey),
        failureKey: errorKey,
      });

      // Closing and restoring must not replace the remembered target with Kilo.
      await releaseChat(opened);
      await enterChat(place, opened);
      expect(snapshotOf(opened)).toMatchObject({
        model: 'kilo/one',
        asked: 'custom question',
        askedModel: target,
        turns: [TURN],
      });
      await retryChat(opened);
      await settled();
      expect(asked).toEqual([{ sessionId: 's1', text: 'first' }]);
      expect(snapshotOf(opened).failed).toBe(i18n.t(errorKey));
    }
  );

  it.each([
    ['deleted', 'modelChat.backends.deletedBackend'],
    ['edited', 'modelChat.backends.staleBackend'],
  ] as const)(
    'reports a pending tool change after an answering backend is %s and retains the queue',
    async (mutation, errorKey) => {
      backendState.profiles = [backend];
      const target = backendTargetId(backend, 'same-model');
      await releaseChat(opened);
      opened = await startChat(place, target);
      await say(opened, 'first', target);
      await settled();
      await say(opened, 'queued custom question', target);
      await say(opened, 'queued Kilo question', 'kilo/one');
      await refreshChatTools();

      backendState.profiles = mutation === 'deleted' ? [] : [{ ...backend, revision: 2 }];
      finish?.();
      await settled();

      expect(asked).toEqual([{ sessionId: 's1', text: 'first' }]);
      expect(clonedWith).toBeUndefined();
      expect(snapshotOf(opened)).toMatchObject({
        model: target,
        turns: [TURN],
        status: 'idle',
        asked: null,
        askedModel: null,
        waiting: ['queued custom question', 'queued Kilo question'],
        failed: i18n.t(errorKey),
        failureKey: errorKey,
      });

      // Retry reattempts the tool move without losing either queued target.
      await retryChat(opened);
      expect(snapshotOf(opened).failed).toBe(i18n.t(errorKey));
      expect(snapshotOf(opened).waiting).toEqual([
        'queued custom question',
        'queued Kilo question',
      ]);
      expect(asked).toHaveLength(1);

      // Only an explicit valid choice can move off the invalid backend.
      await say(opened, 'explicit Kilo recovery', 'kilo/one');
      await settled();
      expect(snapshotOf(opened)).toMatchObject({
        model: 'kilo/one',
        failed: null,
        failureKey: null,
      });
      finish?.();
      await settled();

      expect(asked.map(one => one.text)).toEqual(['first', 'explicit Kilo recovery']);
      expect(snapshotOf(opened)).toMatchObject({
        asked: 'queued custom question',
        askedModel: target,
        waiting: ['queued Kilo question'],
        failed: i18n.t(errorKey),
        failureKey: errorKey,
      });
      expect(await askedIn(snapshotOf(opened).sessionId)).toEqual({
        text: 'queued custom question',
        model: target,
      });
      await retryChat(opened);
      expect(asked).toHaveLength(2);
      expect(snapshotOf(opened).askedModel).toBe(target);

      await say(opened, 'explicit replacement question', 'kilo/one');
      await settled();
      finish?.();
      await settled();
      expect(asked.map(one => one.text)).toEqual([
        'first',
        'explicit Kilo recovery',
        'explicit replacement question',
        'queued Kilo question',
      ]);
      expect(snapshotOf(opened)).toMatchObject({
        model: 'kilo/one',
        asked: 'queued Kilo question',
        askedModel: 'kilo/one',
        waiting: [],
        failed: null,
        failureKey: null,
      });
    }
  );

  it('retries a retained tool change explicitly when its original target is available again', async () => {
    backendState.profiles = [backend];
    const target = backendTargetId(backend, 'same-model');
    await releaseChat(opened);
    opened = await startChat(place, target);
    await say(opened, 'first', target);
    await settled();
    await say(opened, 'second', target);
    await refreshChatTools();
    backendState.profiles = [];
    finish?.();
    await settled();
    expect(snapshotOf(opened).failed).toBe(i18n.t('modelChat.backends.deletedBackend'));
    expect(snapshotOf(opened).waiting).toEqual(['second']);

    backendState.profiles = [backend];
    // Becoming valid does not automatically send anything or select Kilo.
    expect(asked.map(one => one.text)).toEqual(['first']);
    await retryChat(opened);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first', 'second']);
    expect(snapshotOf(opened)).toMatchObject({
      model: target,
      asked: 'second',
      askedModel: target,
      waiting: [],
      failed: null,
      failureKey: null,
    });
  });

  it('reports a failure after a move on the resulting session and retries there', async () => {
    backendState.profiles = [backend];
    const target = backendTargetId(backend, 'same-model');
    failForgetFor = opened;

    await say(opened, 'custom question', target);

    expect(asked).toEqual([]);
    expect(snapshotOf(opened)).toMatchObject({
      sessionId: 's2',
      model: target,
      asked: 'custom question',
      askedModel: target,
      failed: 'session cleanup failed after move',
      failureKey: 'common.somethingWentWrong',
    });
    expect(await askedIn('s1')).toBeNull();
    expect(await askedIn('s2')).toEqual({ text: 'custom question', model: target });

    // The route still names s1; Retry must follow the installed custom session.
    await retryChat(opened);
    await settled();

    expect(asked).toEqual([{ sessionId: 's2', text: 'custom question' }]);
    finish?.();
    await settled();
    expect(snapshotOf(opened)).toMatchObject({
      asked: null,
      askedModel: null,
      failed: null,
      failureKey: null,
    });
    expect(await askedIn('s2')).toBeNull();
  });

  it('retains the target when the custom request fails after a successful move', async () => {
    backendState.profiles = [backend];
    const target = backendTargetId(backend, 'same-model');
    failAnswerFor = 's2';

    await say(opened, 'custom question', target);
    await settled();

    expect(snapshotOf(opened)).toMatchObject({
      sessionId: 's2',
      model: target,
      status: 'idle',
      asked: 'custom question',
      askedModel: target,
      turns: [TURN],
    });
    expect(snapshotOf(opened).failed).not.toBeNull();
    expect(await askedIn('s2')).toEqual({ text: 'custom question', model: target });

    backendState.profiles = [];
    await retryChat(opened);
    await settled();

    expect(asked).toEqual([{ sessionId: 's2', text: 'custom question' }]);
    expect(snapshotOf(opened).failed).toBe(i18n.t('modelChat.backends.deletedBackend'));
  });

  it('replaces a failed question target when the person asks a different question', async () => {
    const target = backendTargetId(backend, 'same-model');
    await say(opened, 'invalid custom question', target);
    expect(snapshotOf(opened).askedModel).toBe(target);

    await say(opened, 'a new Kilo question', 'kilo/one');
    await settled();
    expect(await askedIn(opened)).toEqual({ text: 'a new Kilo question', model: 'kilo/one' });
    finish?.();
    await settled();

    expect(snapshotOf(opened)).toMatchObject({ asked: null, askedModel: null });
    expect(await askedIn(opened)).toBeNull();
  });

  it('migrates old text-only questions on restore without treating their text as target metadata', async () => {
    await releaseChat(opened);
    const text = '{"text":"do not reinterpret me","model":"backend:missing:1:model"}';
    storedQuestions.set(`chat-asked:${opened}`, text);

    await enterChat(place, opened);

    expect(snapshotOf(opened)).toMatchObject({ asked: text, askedModel: 'kilo/one' });
    expect(await askedIn(opened)).toEqual({ text, model: 'kilo/one' });
    expect(storedQuestions.has(`chat-asked:${opened}`)).toBe(false);
    expect(storedQuestions.get(`chat-asked-target:${opened}`)).toBe(
      JSON.stringify({ text, model: 'kilo/one' })
    );
  });

  it('migrates an old question before restoring onto a different tool set', async () => {
    await releaseChat(opened);
    storedQuestions.set(`chat-asked:${opened}`, 'remembered before the upgrade');
    missingToolsFor = opened;

    await enterChat(place, opened);

    expect(snapshotOf(opened)).toMatchObject({
      sessionId: 's2',
      asked: 'remembered before the upgrade',
      askedModel: 'kilo/one',
    });
    expect(await askedIn('s1')).toBeNull();
    expect(await askedIn('s2')).toEqual({
      text: 'remembered before the upgrade',
      model: 'kilo/one',
    });
    expect(storedQuestions.has('chat-asked:s1')).toBe(false);
  });

  it('does not restore a new question record without its target as a Kilo question', async () => {
    await releaseChat(opened);
    storedQuestions.set(`chat-asked-target:${opened}`, JSON.stringify({ text: 'missing target' }));

    await enterChat(place, opened);
    await retryChat(opened);
    await settled();

    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', asked: null, askedModel: null });
    expect(snapshotOf(opened).failed).not.toBeNull();
    expect(asked).toEqual([]);
  });

  it('forgets both the text and target when the question is discarded', async () => {
    const target = backendTargetId(backend, 'same-model');
    await say(opened, 'invalid custom question', target);
    storedQuestions.set(`chat-asked:${opened}`, 'old question');

    await releaseChat(opened);
    await forgetAsked(opened);
    await enterChat(place, opened);

    expect(await askedIn(opened)).toBeNull();
    expect(storedQuestions.has(`chat-asked:${opened}`)).toBe(false);
    expect(snapshotOf(opened)).toMatchObject({ asked: null, askedModel: null });
  });
});
