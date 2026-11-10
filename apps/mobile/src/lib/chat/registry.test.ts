/* eslint-disable max-lines -- the registry suite pins one question at a time, the moves onto another model or tool set, and the MCP discovery around an open on one fake SDK harness. */
import { type ModelEvent, type ModelUsage, type PartDraft, type Turn } from '@kilocode/harness-sdk';
import { Effect, Layer, Queue, Stream } from 'effect';
import { type StoredChatBackend } from './backend-store';
import { backendTargetId, CREDITS_FAILURE_KEY } from './backend-target';
import { asMessages } from './turns';
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

type Asked = {
  readonly sessionId: string;
  readonly text: string;
  /** What was asked, when it was more than words. */
  readonly parts?: readonly PartDraft[];
};

const asked: Asked[] = [];
/** What the session was opened with, so the tools it offers can be read back. */
let openedWith: { readonly tools?: readonly string[] } | undefined = undefined;
/** What a clone was moved onto, so the tool set it names can be read back. */
let clonedWith:
  | { readonly tools?: readonly string[]; readonly model?: string; readonly effort?: string }
  | undefined = undefined;
/** How many moves this run has made: a clone is always a session of its own. */
let clonesMade = 0;
/** The effort the store says a session was opened with. */
let storedEffort: string | null = null;
/**
 * What the store says a session was opened with, so a chat already on the names
 * can be told from one that has to move. Null is a session nothing wrote.
 */
let storedTools: readonly string[] | null = null;
/** Ends the answer that is arriving, so a test decides when a turn finishes. */
let finish: (() => void) | undefined = undefined;
let emitEvent: ((event: ModelEvent) => void) | undefined = undefined;
let storedHistory: readonly Turn[] | undefined = undefined;
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
/** A session whose answer the gateway refuses for the account's balance. */
let creditsFailureFor: string | undefined = undefined;
/** What Kilo's gateway answers when the account cannot pay for the call. */
const PAYMENT_REQUIRED_BODY =
  '{"error":{"message":"Add credits to continue"},"error_type":"usage_limit_exceeded"}';
/**
 * The failure the gateway plugin raises: a status and the body that came with
 * it. The registry reads its fields, and recognises it by type, so the fake
 * wears the prototype of the constructor the module exports. A plain function
 * carries it, which keeps this file to the one class the lint rule allows.
 */
const modelError = vi.hoisted(() => {
  function ModelError(this: { message?: string }) {
    // Only a prototype for `failed()` to wear; nothing constructs one directly.
  }
  return {
    ModelError: ModelError as unknown as new (...args: never[]) => Error,
    failed: (fields: {
      readonly reason: string;
      readonly status?: number;
      readonly cause?: unknown;
    }) =>
      Object.assign(Object.create(ModelError.prototype as object) as Error, {
        name: 'ModelError',
        message: fields.reason,
        ...fields,
      }),
  };
});
/** What one answer costs in the fake, the way the gateway reports a paid call. */
const CALL: ModelUsage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 90,
  cacheWriteTokens: 0,
  cost: 0.01,
};
/** Each fake session's own total, which starts at zero when the session opens, as the SDK's does. */
const totals = new Map<string, ModelUsage>();
const routedTotals = new Map<string, ReadonlyMap<string, ModelUsage>>();
/** The usage column of the chats table, by session. */
const recorded = vi.hoisted(() => new Map<string, unknown>());
/** Makes the next usage write throw, the way a closed database does. */
const recordFailure = vi.hoisted(() => ({ next: false }));
/** The names a stored session was opened with, which must resolve for it to continue. */
let continuesWith: readonly string[] = [];
/** Every session whose scope was closed, so a leaked one can be told from one released. */
const released: string[] = [];
/**
 * Holds a scope's close open, so a test can open the same chat again while the
 * close still runs, which is the moment the ordering is about.
 */
let closing: Promise<void> | undefined = undefined;

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

vi.mock('./local-models', () => ({ localModelProvider: () => undefined }));
const backendState = vi.hoisted(() => ({ profiles: [] as StoredChatBackend[], failNext: false }));
vi.mock('./backend-store', () => ({
  listChatBackends: () => backendState.profiles,
  waitForChatBackends: async () => {
    await Promise.resolve();
    if (backendState.failNext) {
      backendState.failNext = false;
      throw new Error('the backends could not be read');
    }
  },
}));

/** One stored turn, so a state that still holds turns can be told from an empty one. */
const TURN = {
  id: 'trn_1',
  sessionId: 's1',
  role: 'user',
  parts: [{ id: 'prt_1', kind: 'text', body: 'hi' }],
} as const;

/** The answer to it: an answered question is stored as both turns, not as one. */
const ANSWER = {
  id: 'trn_2',
  sessionId: 's1',
  role: 'assistant',
  parts: [{ id: 'prt_2', kind: 'text', body: 'because' }],
} as const;

const handleFor = (id: string) => {
  totals.set(id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  routedTotals.delete(id);
  return {
    id,
    ask: (input: string | readonly PartDraft[]) => {
      const said: Asked =
        typeof input === 'string'
          ? { sessionId: id, text: input }
          : {
              sessionId: id,
              text: input.flatMap(part => (part.kind === 'text' ? [part.body] : [])).join(''),
              parts: input,
            };
      if (failAnswerFor === id) {
        asked.push(said);
        return Stream.fail(new Error('custom answer failed'));
      }
      if (creditsFailureFor === id) {
        asked.push(said);
        return Stream.fail(
          modelError.failed({ reason: 'status', status: 402, cause: PAYMENT_REQUIRED_BODY })
        );
      }
      return Stream.callback<ModelEvent>(queue =>
        Effect.sync(() => {
          asked.push(said);
          emitEvent = event => {
            Queue.offerUnsafe(queue, event);
          };
          Queue.offerUnsafe(queue, { kind: 'delta', text: 'ok' });
          finish = () => {
            const held = totals.get(id);
            totals.set(id, {
              inputTokens: (held?.inputTokens ?? 0) + CALL.inputTokens,
              outputTokens: (held?.outputTokens ?? 0) + CALL.outputTokens,
              cacheReadTokens: (held?.cacheReadTokens ?? 0) + CALL.cacheReadTokens,
              cacheWriteTokens: 0,
              cost: (held?.cost ?? 0) + (CALL.cost ?? 0),
            });
            Queue.offerUnsafe(queue, { kind: 'done', usage: CALL, stop: 'end' });
            Queue.endUnsafe(queue);
          };
          return Effect.void;
        })
      );
    },
    history: Effect.suspend(() =>
      failHistoryFor === id
        ? Effect.fail(new Error('history unreadable'))
        : Effect.succeed(storedHistory ?? [TURN])
    ),
    usage: Effect.sync(() => totals.get(id)),
    usageByModel: Effect.sync(() => {
      const routed = routedTotals.get(id);
      const total = totals.get(id);
      return (
        routed ?? (total?.cost === undefined ? new Map() : new Map([[snapshotOf(id).model, total]]))
      );
    }),
  };
};

/** Opens a session that is released when the scope holding it closes. */
const openInScope = (id: string) =>
  Effect.acquireRelease(Effect.succeed(handleFor(id)), () =>
    Effect.promise(async () => {
      await closing;
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
    // Failure copy is read from the error itself before any model error cause.
    ModelError: modelError.ModelError,
    zeroUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    openSession: (options: { readonly tools?: readonly string[] }) => {
      openedWith = options;
      return Effect.succeed(handleFor('s1'));
    },
    continueSession: (id: string) => {
      continued.push(id);
      if (failOpenFor === id) {
        return openInScope(id).pipe(Effect.andThen(Effect.fail(new Error('no such session'))));
      }
      if (missingToolsFor === id) {
        return Effect.fail(new FakeToolMissingError());
      }
      if (continuesWith.some(name => !remote.tools.some(one => one.definition.name === name))) {
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
      clonesMade += 1;
      return Effect.succeed(handleFor(`s${clonesMade + 1}`));
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
// The search itself is proved in its own suite; this one reads the names.
vi.mock('./web-search', () => ({
  WEB_SEARCH_TOOL_NAME: 'web_search',
  webSearchTool: () => ({ definition: { name: 'web_search' }, run: () => undefined }),
}));
vi.mock('@/lib/settings/registry', () => ({
  settingsService: () => ({ settings: [], read: () => undefined, write: () => undefined }),
}));
vi.mock('@/lib/settings/confirm', () => ({ confirmSettingChange: () => undefined }));
// The person's own remote servers; what is under test is the registry's use of
// the names, not the discovery. Nothing is discovered until a chat asks, which
// is what a fresh start looks like.
const remote = vi.hoisted(() => {
  const held = {
    tools: [] as { readonly definition: { readonly name: string } }[],
    /** What the servers offer once asked. */
    offered: [] as { readonly definition: { readonly name: string } }[],
    ensure: vi.fn(async () => {
      await Promise.resolve();
      for (const one of held.offered) {
        if (!held.tools.includes(one)) {
          held.tools.push(one);
        }
      }
      return [];
    }),
  };
  return held;
});
vi.mock('./remote-mcp', () => ({
  ensureRemoteMcp: remote.ensure,
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
/**
 * The scope recorded for each chat, which is what the store's `chats` row holds.
 * A start writes it and a move carries it to the session the chat moved onto.
 */
const scopes = vi.hoisted(() => {
  const held = new Map<string, string>();
  return {
    of: (sessionId: string) => held.get(sessionId) ?? null,
    record: (sessionId: string, scope: string) => {
      if (!held.has(sessionId)) {
        held.set(sessionId, scope);
      }
    },
    move: (from: string, to: string) => {
      const scope = held.get(from);
      held.delete(from);
      if (scope !== undefined) {
        held.set(to, scope);
      }
    },
    clear: () => {
      held.clear();
    },
  };
});
/** Every session a reopen asked the SDK for, so an open that never ran is told. */
let continued: string[] = [];

vi.mock('./store', () => ({
  forgetSession: (_database: unknown, sessionId: string) => {
    if (failForgetFor === sessionId) {
      failForgetFor = undefined;
      throw new Error('session cleanup failed after move');
    }
  },
  modelOfSession: () => 'kilo/one',
  effortOfSession: () => storedEffort,
  moveChat: (_database: unknown, move: { readonly from: string; readonly to: string }) => {
    recorded.set(move.to, recorded.get(move.from));
    recorded.delete(move.from);
    scopes.move(move.from, move.to);
  },
  rememberChat: (
    _database: unknown,
    chat: { readonly sessionId: string; readonly scope: string; readonly at: number }
  ) => {
    scopes.record(chat.sessionId, chat.scope);
  },
  scopeOfChat: (_database: unknown, sessionId: string) => scopes.of(sessionId),
  touchChat: () => undefined,
  toolsOfSession: () => storedTools,
  NO_RECORD: { createdAt: null, updatedAt: null, usage: {}, prompted: 0, effort: null },
  recordOfChat: (_database: unknown, sessionId: string) => ({
    createdAt: 1,
    updatedAt: 1,
    usage: recorded.get(sessionId) ?? {},
    prompted: 0,
    effort: null,
  }),
  recordUsage: (_database: unknown, sessionId: string, usage: unknown) => {
    if (recordFailure.next) {
      recordFailure.next = false;
      throw new Error('database closed');
    }
    recorded.set(sessionId, usage);
  },
}));

const {
  enterChat,
  refreshChatTools,
  releaseChat,
  retryChat,
  retryKiloMcp,
  say,
  setMcpEnabled,
  setWebSearchEnabled,
  startChat,
  stopChat,
} = await import('./registry');
const { change, snapshotOf } = await import('./state');
const { chatPlaceOf } = await import('./scope');
const { askedIn, firstQuestionIn, forgetAsked, keptIn } = await import('./pending');

/** The words of the line that is waiting, which is what most of these read. */
const waitingWords = (sessionId: string) => snapshotOf(sessionId).waiting.map(one => one.text);

const place = { chatScope: 'me:personal', org: { kind: 'personal' } } as const;

/** Where another account's chats are. */
const otherAccount = { chatScope: 'other:personal', org: { kind: 'personal' } } as const;

/** Where the same person's chats are while another organization is selected. */
const otherOrganization = {
  chatScope: 'me:org-1',
  org: { kind: 'organization', id: 'org-1' },
} as const;

/**
 * Records a chat row the way starting one does, so a test can hand the open an
 * id that was recorded somewhere else.
 */
const storedChat = (sessionId: string, at: { readonly chatScope: string }) => {
  scopes.record(sessionId, at.chatScope);
};

/** The settings tools a chat is opened with while the group switch is on. */
const SETTINGS = ['settings_list', 'settings_set'];

/** What every Kilo chat is opened with: the clock, and web search, which is on by default for it. */
const BASE = ['time', 'web_search'];

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
  closing = undefined;
  finish = undefined;
  emitEvent = undefined;
  storedHistory = undefined;
  failOpenFor = undefined;
  missingToolsFor = undefined;
  missingCloneFor = undefined;
  failHistoryFor = undefined;
  failForgetFor = undefined;
  failAnswerFor = undefined;
  creditsFailureFor = undefined;
  storedQuestions.clear();
  clonedWith = undefined;
  clonesMade = 0;
  storedEffort = null;
  openedWith = undefined;
  storedTools = null;
  recorded.clear();
  scopes.clear();
  continued = [];
  recordFailure.next = false;
  settingsSwitch.enabled = true;
  mcp.tools.length = 0;
  mcp.enabled.clear();
  remote.tools.length = 0;
  remote.offered.length = 0;
  continuesWith = [];
  backendState.profiles = [];
  backendState.failNext = false;
  opened = await startChat(place, { model: 'kilo/one', effort: null });
  await settled();
  /* Cleared after the chat above, so a test counts only its own discoveries. */
  mcp.ensure.mockClear();
  remote.ensure.mockClear();
});

describe('what a chat is opened with', () => {
  it('offers the clock, because a model has none and answers from a stale date', () => {
    expect(openedWith?.tools).toEqual([...BASE, ...SETTINGS]);
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

    await say(opened, { text: 'hello', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(clonedWith).toEqual({ tools: BASE });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('drops the settings tools on the next question even if the chat was never marked', async () => {
    /* A chat that did not exist when the switch moved is not in the map to
       mark. The store still holds the names it was opened with, so the next
       question compares those with the switch as it stands now rather than
       offering a tool the person just took away. */
    storedTools = [...BASE, ...SETTINGS];
    settingsSwitch.enabled = false;
    await say(opened, { text: 'hello', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(clonedWith).toEqual({ tools: BASE });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('leaves a chat alone when the switch that moved was not its own', async () => {
    /* A server's flag flipping is not this chat's: it names none of that
       server's tools, so its set did not move and its session is not copied. */
    storedTools = [...BASE, ...SETTINGS];
    await refreshChatTools();
    await settled();

    await say(opened, { text: 'hello', images: [] }, { model: 'kilo/one', effort: null });
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

    opened = await startChat(place, { model: 'kilo/one', effort: null });
    await settled();

    /* The open asks for the automatic deadline, so a slow server leaves the
       chat opening rather than holding the send on it. */
    expect(mcp.ensure).toHaveBeenCalledWith(place, 'automatic');
    expect(openedWith?.tools).toEqual([...BASE, ...SETTINGS, 'mcp_kilo_read-file']);
  });

  it('opens a chat with the setting off on the clock alone, and reaches no server', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);

    opened = await startChat(place, { model: 'kilo/one', effort: null }, false);
    await settled();

    expect(openedWith?.tools).toEqual([...BASE, ...SETTINGS]);
    expect(mcp.ensure).not.toHaveBeenCalled();
  });

  it('reaches the server when the setting is turned on for a chat that never discovered', async () => {
    /* The chat was opened with the setting off, so no discovery ran and the
       connection is idle. Turning it on has to ask the server: without that the
       chat is moved onto the base tools, the view stays "not available", and
       the switch the person just turned on snaps back off. */
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, { model: 'kilo/one', effort: null }, false);
    await settled();
    expect(mcp.ensure).not.toHaveBeenCalled();

    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: mcp.tools });
    await setMcpEnabled(opened, true);
    await settled();

    expect(mcp.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ chatScope: 'me:personal' }),
      'automatic'
    );
    expect(clonedWith).toEqual({ tools: [...BASE, ...SETTINGS, 'mcp_kilo_read-file'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('moves an idle chat off the server tools when the setting is turned off', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, { model: 'kilo/one', effort: null });
    await settled();
    expect(snapshotOf(opened).sessionId).toBe('s1');

    await setMcpEnabled(opened, false);
    await settled();

    /* The tool set is frozen for the life of a session, so turning it off is a
       copy onto a session without those tools, and the setting follows it. */
    expect(clonedWith).toEqual({ tools: [...BASE, ...SETTINGS] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
    expect(mcp.enabled.get('s2')).toBe(false);
  });

  it('applies a choice made while an answer was arriving once it settles', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await setMcpEnabled(opened, false);
    await settled();

    /* Never under an answer that is still coming: the chat has not moved. */
    expect(clonedWith).toBeUndefined();
    expect(snapshotOf(opened).sessionId).toBe('s1');

    finish?.();
    await settled();

    expect(clonedWith).toEqual({ tools: [...BASE, ...SETTINGS] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('opens a stored chat whose tool names no longer resolve, on the names now held', async () => {
    mcp.tools.push(discovered);
    missingToolsFor = 'stale';
    storedChat('stale', place);

    await enterChat(place, 'stale');
    await settled();

    /* The server's list moved on, or it is down while the session was stored
       with its tools. The chat opens either way rather than failing on a name
       nothing holds. */
    expect(clonedWith).toEqual({ tools: [...BASE, ...SETTINGS, 'mcp_kilo_read-file'] });
    expect(snapshotOf('stale').status).toBe('idle');
    expect(snapshotOf('stale').failed).toBeNull();

    /* The chat it opened is released here, so the session it moved onto does
       not outlive the test that made it. */
    await releaseChat('stale');
  });

  it('moves onto another model on the names it holds when the stored ones no longer resolve', async () => {
    mcp.tools.push(discovered);
    await releaseChat(opened);
    opened = await startChat(place, { model: 'kilo/one', effort: null });
    await settled();
    expect(openedWith?.tools).toEqual([...BASE, ...SETTINGS, 'mcp_kilo_read-file']);

    /* A call that did not reach the server dropped the tools from the registry,
       so the session is stored naming one nothing holds. Switching the model
       must still move the chat rather than report the send as failed. */
    mcp.tools.length = 0;
    missingCloneFor = opened;

    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
    await settled();

    expect(clonedWith).toEqual({ model: 'kilo/two', tools: [...BASE, ...SETTINGS] });
    expect(snapshotOf(opened).failed).toBeNull();
    expect(snapshotOf(opened).sessionId).toBe('s2');
    expect(asked.at(-1)).toEqual({ sessionId: 's2', text: 'second' });
  });

  it('retries a failed discovery and moves the chat onto the tools that answered', async () => {
    /* The chat opened while the server was down, so it named the clock alone.
       The retry finds the server, and the session is frozen on what it was
       opened with, so the recovered tools need a session that names them. */
    await releaseChat(opened);
    opened = await startChat(place, { model: 'kilo/one', effort: null });
    await settled();
    expect(openedWith?.tools).toEqual([...BASE, ...SETTINGS]);

    mcp.tools.push(discovered);
    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: mcp.tools });
    await retryKiloMcp(opened);
    await settled();

    expect(mcp.ensure).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatScope: 'me:personal' }),
      'retry'
    );
    expect(clonedWith).toEqual({ tools: [...BASE, ...SETTINGS, 'mcp_kilo_read-file'] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('leaves the chat where it is when the retry still finds no tools', async () => {
    await releaseChat(opened);
    opened = await startChat(place, { model: 'kilo/one', effort: null });
    await settled();
    clonedWith = undefined;

    mcp.ensure.mockResolvedValueOnce({ status: 'ready', tools: [] });
    await retryKiloMcp(opened);
    await settled();

    expect(clonedWith).toBeUndefined();
    expect(snapshotOf(opened).sessionId).toBe('s1');
  });
});

describe('web search in a chat', () => {
  const backend: StoredChatBackend = {
    id: 'tools-server',
    revision: 1,
    name: 'Tools',
    baseUrl: 'https://tools.example/v1',
    apiKind: 'chat_completions',
    apiKey: '',
    headers: {},
    models: [{ id: 'tool-model', name: 'Model', tools: true, images: false, reasoning: false }],
    allowLocalHttp: false,
  };

  it('is off for a new chat on a custom model, and the switch turns it on', async () => {
    backendState.profiles = [backend];
    const target = backendTargetId(backend, 'tool-model');
    await releaseChat(opened);
    opened = await startChat(place, { model: target, effort: null });
    await settled();

    expect(openedWith?.tools).toEqual(['time', ...SETTINGS]);

    storedTools = ['time', ...SETTINGS];
    await setWebSearchEnabled(opened, true);
    await settled();

    expect(clonedWith).toEqual({ tools: [...BASE, ...SETTINGS] });
  });

  it('moves an idle Kilo chat off web search when the person turns it off', async () => {
    storedTools = [...BASE, ...SETTINGS];

    await setWebSearchEnabled(opened, false);
    await settled();

    expect(clonedWith).toEqual({ tools: ['time', ...SETTINGS] });
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('keeps the person choice when the chat moves onto another model', async () => {
    storedTools = [...BASE, ...SETTINGS];
    await setWebSearchEnabled(opened, false);
    await settled();
    storedTools = ['time', ...SETTINGS];

    await say(opened, { text: 'hello', images: [] }, { model: 'kilo/two', effort: null });
    await settled();

    expect(clonedWith).toEqual({ model: 'kilo/two' });
  });
});

describe('a second question while the first is being answered', () => {
  it('waits rather than starting a second read of the session', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first']);
    expect(waitingWords(opened)).toEqual(['second']);
  });

  it('is asked when the answer lands, on the model it was sent with', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
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

  it('is asked when the answer lands, with the effort it was sent with', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'think hard', images: [] }, { model: 'kilo/one', effort: 'high' });
    await settled();

    finish?.();
    await settled();

    expect(clonedWith).toEqual({ effort: 'high' });
    expect(asked.at(-1)).toEqual({ sessionId: 's2', text: 'think hard' });
  });

  it('is asked when the person stops the answer, because they still asked it', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await stopChat(opened);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first', 'second']);
  });

  it('goes with the chat when the chat is closed', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await releaseChat(opened);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first']);
  });
});

describe('a question with images', () => {
  const image = { media: 'image/jpeg', data: 'AAAA' };

  it('asks the session with the images first and the words after', async () => {
    await say(
      opened,
      { text: 'what is this', images: [image] },
      { model: 'kilo/one', effort: null }
    );
    await settled();

    expect(asked.at(-1)?.parts).toEqual([
      { kind: 'image', body: 'AAAA', media: 'image/jpeg' },
      { kind: 'text', body: 'what is this' },
    ]);
    expect(snapshotOf(opened).askedImages).toEqual([image]);
    expect(await askedIn(opened)).toEqual({
      text: 'what is this',
      model: 'kilo/one',
      effort: null,
      images: [image],
      failureKey: null,
    });
  });

  it('sends an image with no words as the image alone', async () => {
    await say(opened, { text: '', images: [image] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(asked.at(-1)?.parts).toEqual([{ kind: 'image', body: 'AAAA', media: 'image/jpeg' }]);
  });

  it('keeps its images when the answer fails and the person retries', async () => {
    failAnswerFor = opened;
    await say(
      opened,
      { text: 'what is this', images: [image] },
      { model: 'kilo/one', effort: null }
    );
    await settled();
    expect(snapshotOf(opened)).toMatchObject({ asked: 'what is this', askedImages: [image] });

    failAnswerFor = undefined;
    await retryChat(opened);
    await settled();

    expect(asked.map(one => one.parts)).toEqual([
      [
        { kind: 'image', body: 'AAAA', media: 'image/jpeg' },
        { kind: 'text', body: 'what is this' },
      ],
      [
        { kind: 'image', body: 'AAAA', media: 'image/jpeg' },
        { kind: 'text', body: 'what is this' },
      ],
    ]);
    finish?.();
    await settled();
    expect(snapshotOf(opened)).toMatchObject({ asked: null, askedImages: [] });
  });

  it('carries the images of a question that waited for the answer before it', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'and this', images: [image] }, { model: 'kilo/one', effort: null });
    await settled();
    expect(snapshotOf(opened).waiting).toEqual([{ text: 'and this', images: [image] }]);

    finish?.();
    await settled();

    expect(asked.at(-1)?.parts).toEqual([
      { kind: 'image', body: 'AAAA', media: 'image/jpeg' },
      { kind: 'text', body: 'and this' },
    ]);
  });
});

describe('a send the account cannot pay for', () => {
  it('keeps the first question of a chat and says why it did not go', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';

    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const held = snapshotOf(opened);
    expect(held).toMatchObject({
      status: 'idle',
      asked: 'first',
      askedModel: 'kilo/one',
      failureKey: CREDITS_FAILURE_KEY,
      turns: [],
    });

    /* Nothing was written for the chat yet, so the question on screen is the
       remembered one — the bubble its Retry and Copy to composer hang off. */
    const drawn = asMessages(held);
    expect(drawn.map(one => one.info.id)).toEqual([`${held.sessionId}:asked`]);
    expect(drawn[0]?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'first' })]);

    creditsFailureFor = undefined;
    await retryChat(opened);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first', 'first']);

    finish?.();
    await settled();
    expect(snapshotOf(opened)).toMatchObject({ asked: null, failureKey: null });
  });

  it('still says why after the chat is opened again', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';

    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await releaseChat(opened);
    await enterChat(place, opened);

    /* The reason is kept with the question that waits, so a chat opened again —
       after a restart, or after the app reloads to switch language — still says
       the balance stopped the send instead of reading as a message the person
       stopped. The banner and its Add credits control hang off this key. */
    expect(snapshotOf(opened)).toMatchObject({
      status: 'idle',
      asked: 'first',
      askedModel: 'kilo/one',
      failureKey: CREDITS_FAILURE_KEY,
    });
    expect(await askedIn(opened)).toMatchObject({ failureKey: CREDITS_FAILURE_KEY });

    creditsFailureFor = undefined;
    await retryChat(opened);
    await settled();
    finish?.();
    await settled();

    await releaseChat(opened);
    await enterChat(place, opened);
    expect(snapshotOf(opened)).toMatchObject({ asked: null, failureKey: null });
  });
});

describe('a question a later send took the slot from', () => {
  it('keeps the failed words in the transcript, before the question that replaced them', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';

    await say(
      opened,
      { text: 'the long question', images: [] },
      { model: 'kilo/one', effort: null }
    );
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const held = snapshotOf(opened);
    /* It keeps everything needed to ask it again, and where it was said: no
       turn was stored for it, so it goes before every one of them. */
    expect(held.displaced).toMatchObject([
      {
        text: 'the long question',
        images: [],
        model: 'kilo/one',
        effort: null,
        afterTurns: 0,
        outcome: 'failed',
      },
    ]);
    const [kept] = held.displaced;
    if (kept === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    // The identifier names its bubble, and is the one its Retry finds it by.
    expect(asMessages(held).map(one => one.info.id)).toEqual([
      `${held.sessionId}:displaced:${kept.id}`,
      `${held.sessionId}:asked`,
    ]);
    // Written down with the chat, so reopening it keeps the bubble.
    expect(await keptIn(held.sessionId)).toEqual(held.displaced);
  });

  it('says why the newest question failed after a reopen, with the kept one still above it', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await releaseChat(opened);
    await enterChat(place, opened);

    /* Both records are read back: the words of the question a later send took
       the slot from, and why the question now in the slot has no answer. The
       banner and its Add credits control hang off the second. */
    const held = snapshotOf(opened);
    expect(held).toMatchObject({ asked: 'second', failureKey: CREDITS_FAILURE_KEY });
    expect(held.displaced.map(one => one.text)).toEqual(['first']);
    const kept = held.displaced[0];
    expect(asMessages(held).map(one => one.info.id)).toEqual([
      `${held.sessionId}:displaced:${kept?.id}`,
      `${held.sessionId}:asked`,
    ]);
  });

  it('is on screen above the answer that came after it', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    /* The next question moves the chat onto another model, which is a session
       the gateway answers for, so an answer lands after the failure. */
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
    await settled();
    storedHistory = [TURN];
    finish?.();
    await settled();

    const held = snapshotOf(opened);
    // Said before the turn the store now holds, so it stays above it.
    expect(held.turns).toEqual([TURN]);
    const drawn = asMessages(held).map(one => one.info.id);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toMatch(/:displaced:/);
    expect(drawn[1]).toBe(TURN.id);
  });

  it('is asked again from its own Retry, on the model it was asked of', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
    await settled();
    finish?.();
    await settled();

    const kept = snapshotOf(opened).displaced[0];
    if (kept === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    asked.length = 0;
    clonedWith = undefined;
    creditsFailureFor = undefined;

    await retryChat(opened, kept);
    await settled();

    /* It stays in the transcript where it was said, and the slot draws no
       second bubble for it: the attempt on screen is that one bubble. */
    expect(snapshotOf(opened).displaced.map(one => one.text)).toEqual(['first']);
    expect(snapshotOf(opened).askedFrom).toBe(kept.id);
    const drawn = asMessages(snapshotOf(opened)).map(one => one.info.id);
    expect(drawn[0]).toBe(`${snapshotOf(opened).sessionId}:displaced:${kept.id}`);
    expect(drawn).not.toContain(`${snapshotOf(opened).sessionId}:asked`);
    expect(asked.map(one => one.text)).toEqual(['first']);
    // Asked on the model it was asked of, not the one the chat is on now.
    expect(clonedWith).toEqual({ model: 'kilo/one' });
    expect(snapshotOf(opened).askedModel).toBe('kilo/one');

    finish?.();
    await settled();
    expect(snapshotOf(opened).asked).toBeNull();
    // The answer is a stored turn now, so the bubble it was asked at goes.
    expect(snapshotOf(opened).displaced).toEqual([]);
  });

  it('stays above the question said after it when it is asked again', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const [first] = snapshotOf(opened).displaced;
    if (first === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    expect(snapshotOf(opened).asked).toBe('second');

    await retryChat(opened, first);
    await settled();

    /* The conversation reads in the order it was said: the question asked
       again stays where it was, and the one said after it — kept when the slot
       was taken back — stays under it. */
    const [askedFirst, second] = snapshotOf(opened).displaced;
    if (askedFirst === undefined || second === undefined) {
      throw new TypeError('both failed questions were not kept');
    }
    expect(askedFirst.id).toBe(first.id);
    expect(asMessages(snapshotOf(opened)).map(one => one.info.id)).toEqual([
      `${opened}:displaced:${first.id}`,
      `${opened}:displaced:${second.id}`,
    ]);
    expect(snapshotOf(opened).askedFrom).toBe(first.id);
    // Its own copy survives the attempt, because its bubble is on screen.
    const written = await keptIn(opened);
    expect(written.map(one => one.id)).toEqual([first.id, second.id]);
  });

  it('is asked once when its Retry is pressed twice', async () => {
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const kept = snapshotOf(opened).displaced[0];
    if (kept === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    asked.length = 0;

    await retryChat(opened, kept);
    // The second press holds the entry the first one took away.
    await retryChat(opened, kept);
    await settled();

    expect(asked.map(one => one.text)).toEqual(['first']);
  });

  it('is queued once when its Retry is pressed twice while another answer arrives', async () => {
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const kept = snapshotOf(opened).displaced[0];
    if (kept === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    creditsFailureFor = undefined;
    // An answer is arriving, so the retry waits behind it rather than asking now.
    await say(opened, { text: 'third', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await retryChat(opened, kept);
    // The second press finds the question already in the line.
    await retryChat(opened, kept);
    await settled();

    expect(waitingWords(opened)).toEqual(['first']);
  });

  it('keeps a question said after it under its answer once it is asked again', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const [first] = snapshotOf(opened).displaced;
    if (first === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    creditsFailureFor = undefined;
    await retryChat(opened, first);
    await settled();
    /* The answer to the question asked again is stored as its own turn and the
       answer's, which is what the exchange writes. */
    storedHistory = [TURN, ANSWER];
    finish?.();
    await settled();

    const held = snapshotOf(opened);
    /* The question said after the one it answers moves under both stored turns,
       so it reads after the answer rather than between it and its question. */
    expect(held.displaced.map(one => [one.text, one.afterTurns])).toEqual([['second', 2]]);
    expect(asMessages(held).map(one => one.info.id)).toEqual([
      TURN.id,
      ANSWER.id,
      `${held.sessionId}:displaced:${held.displaced[0]?.id ?? ''}`,
    ]);
    // The list is written as it is drawn, so a reopen keeps the order.
    const written = await keptIn(held.sessionId);
    expect(written.map(one => one.afterTurns)).toEqual([2]);
  });

  it('is still named for the question that opened the chat after it is asked again', async () => {
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const kept = snapshotOf(opened).displaced[0];
    if (kept === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    // The first question stays the chat's name, and stays where it was said,
    // while the question said after it is kept under it.
    await retryChat(opened, kept);
    await settled();

    expect(snapshotOf(opened).displaced.map(one => one.text)).toEqual(['first', 'second']);
    expect(await firstQuestionIn(opened)).toBe('first');
  });

  it('is kept when what took its slot was the person stopping the answer', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    // The second question waits; stopping the first lets it be asked.
    await stopChat(opened);
    await settled();

    expect(snapshotOf(opened).displaced.map(one => one.text)).toEqual(['first']);
    expect(snapshotOf(opened).asked).toBe('second');
  });

  it('keeps the written copy of a retry still waiting when another question is asked', async () => {
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'third', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    const held = snapshotOf(opened).displaced;
    expect(held.map(one => one.text)).toEqual(['first', 'second']);

    creditsFailureFor = undefined;
    await say(opened, { text: 'fourth', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    // Both retries wait for the answer arriving, with nothing but their written
    // copies to survive a restart.
    await retryChat(opened, held[0]);
    await retryChat(opened, held[1]);
    await settled();
    expect(snapshotOf(opened).waiting.map(one => one.text)).toEqual(['first', 'second']);
    // The third one the fourth send pushed out of the slot is written too.
    const waiting = await keptIn(opened);
    expect(waiting.map(one => one.text)).toEqual(['first', 'second', 'third']);

    // The answer lands and the first retry is asked, which writes its own copy
    // away without touching the one still waiting behind it.
    finish?.();
    await settled();
    /* The first retry is the slot's question now, so its own copy stays while
       it is asked, and the one waiting behind it keeps its copy too. */
    const written = await keptIn(opened);
    expect(written.map(one => one.text)).toEqual(['first', 'second', 'third']);
  });

  it('keeps the earlier failed bubble when the same question is sent again', async () => {
    storedHistory = [];
    creditsFailureFor = 's1';
    await say(opened, { text: 'the same words', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'the same words', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    const held = snapshotOf(opened);
    // The first failure is a bubble of its own, and the second is the slot's.
    expect(held.displaced.map(one => one.text)).toEqual(['the same words']);
    expect(asMessages(held)).toHaveLength(2);
  });

  it('reopens a question it was asked again where it was said', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('interrupted', place);
    /* The slot names the kept question it asks again, and the list holds that
       question and the one said after it: the open draws both once, in the
       order they were asked. */
    const question = {
      text: 'the question asked again',
      model: 'kilo/one',
      effort: null,
      images: [],
    };
    storedQuestions.set(
      `chat-asked-target:interrupted`,
      JSON.stringify({ ...question, from: 'a' })
    );
    storedQuestions.set(
      'chat-kept-questions:interrupted',
      JSON.stringify([
        { id: 'a', ...question, afterTurns: 0, outcome: 'failed' },
        {
          id: 'b',
          text: 'the failure it was slid above',
          model: 'kilo/one',
          effort: null,
          images: [],
          afterTurns: 0,
          outcome: 'failed',
        },
      ])
    );

    await enterChat(place, 'interrupted');
    await settled();

    const held = snapshotOf('interrupted');
    /* Both are kept questions, and the second was said after the first: the
       attempt is the earlier bubble rather than a copy at the bottom. */
    expect(held.displaced.map(one => one.text)).toEqual([
      'the question asked again',
      'the failure it was slid above',
    ]);
    expect(held.askedFrom).toBe('a');
    expect(asMessages(held).map(one => one.info.id)).toEqual([
      'interrupted:displaced:a',
      'interrupted:displaced:b',
    ]);
    // Both stay written: each is a bubble the conversation cannot rebuild.
    const written = await keptIn('interrupted');
    expect(written.map(one => one.id)).toEqual(['a', 'b']);
  });

  it('drops both records of a question whose answer landed before the slot was cleared', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('answered', place);
    /* The answer landed, the kept record was dropped, and the process stopped
       before the slot's record was cleared. */
    storedHistory = [
      {
        id: 'trn_9',
        sessionId: 'answered',
        role: 'user',
        parts: [{ id: 'p1', kind: 'text', body: 'the question asked again' }],
      },
      {
        id: 'trn_10',
        sessionId: 'answered',
        role: 'assistant',
        parts: [{ id: 'p2', kind: 'text', body: 'the answer' }],
      },
    ];
    storedQuestions.set(
      'chat-asked-target:answered',
      JSON.stringify({
        text: 'the question asked again',
        model: 'kilo/one',
        effort: null,
        images: [],
        from: 'a',
      })
    );

    await enterChat(place, 'answered');
    await settled();

    const held = snapshotOf('answered');
    // The answer is the transcript; no failed bubble stands beside it.
    expect(held.asked).toBeNull();
    expect(held.displaced).toEqual([]);
    expect(asMessages(held).map(one => one.info.id)).toEqual(['trn_9', 'trn_10']);
    expect(await askedIn('answered')).toBeNull();
  });

  it('does not fold a later attempt that repeats an earlier answered question', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('repeat', place);
    /* The first "hi" was answered long before; the second, said after two turns,
       failed and was asked again when the app stopped. */
    const words = {
      text: 'hi',
      model: 'kilo/one',
      effort: null,
      images: [],
      afterTurns: 2,
      outcome: 'failed' as const,
    };
    storedHistory = [
      {
        id: 'trn_13',
        sessionId: 'repeat',
        role: 'user',
        parts: [{ id: 'p1', kind: 'text', body: 'hi' }],
      },
      {
        id: 'trn_14',
        sessionId: 'repeat',
        role: 'assistant',
        parts: [{ id: 'p2', kind: 'text', body: 'the earlier answer' }],
      },
    ];
    storedQuestions.set('chat-asked-target:repeat', JSON.stringify({ ...words, from: 'a' }));
    storedQuestions.set('chat-kept-questions:repeat', JSON.stringify([{ id: 'a', ...words }]));

    await enterChat(place, 'repeat');
    await settled();

    // The earlier answer is not this attempt's answer: the bubble and its Retry stay.
    const held = snapshotOf('repeat');
    expect(held.asked).toBe('hi');
    expect(held.askedFrom).toBe('a');
    expect(held.displaced.map(one => one.id)).toEqual(['a']);
    const written = await keptIn('repeat');
    expect(written.map(one => one.id)).toEqual(['a']);
  });

  it('does not fold a retry whose answer never came when the same words were answered before', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('retry-lost', place);
    /* "hi" failed and was kept; "hi" sent again was answered, which stored its
       turn; then the kept one was asked again and its answer never came. The
       answer the store holds is not the retry's. */
    const words = {
      text: 'hi',
      model: 'kilo/one',
      effort: null,
      images: [],
      afterTurns: 0,
      outcome: 'failed' as const,
    };
    storedHistory = [
      {
        id: 'trn_15',
        sessionId: 'retry-lost',
        role: 'user',
        parts: [{ id: 'p1', kind: 'text', body: 'hi' }],
      },
      {
        id: 'trn_16',
        sessionId: 'retry-lost',
        role: 'assistant',
        parts: [{ id: 'p2', kind: 'text', body: 'the earlier answer' }],
      },
    ];
    storedQuestions.set(
      'chat-asked-target:retry-lost',
      JSON.stringify({ ...words, from: 'a', after: 2 })
    );
    storedQuestions.set('chat-kept-questions:retry-lost', JSON.stringify([{ id: 'a', ...words }]));

    await enterChat(place, 'retry-lost');
    await settled();

    // Its bubble and its Retry stay: the stored turn is not the answer to it.
    const held = snapshotOf('retry-lost');
    expect(held.asked).toBe('hi');
    expect(held.askedFrom).toBe('a');
    expect(held.displaced.map(one => one.id)).toEqual(['a']);
  });

  it('folds a question whose answer is the newest question after tool results', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('tooled', place);
    /* The answer used the chat's tool, so its results are stored as a user turn
       with no text, after the question and before the answer's own words. */
    const words = {
      text: 'what time is it',
      model: 'kilo/one',
      effort: null,
      images: [],
      afterTurns: 0,
      outcome: 'failed' as const,
    };
    storedHistory = [
      {
        id: 'trn_17',
        sessionId: 'tooled',
        role: 'user',
        parts: [{ id: 'p1', kind: 'text', body: words.text }],
      },
      {
        id: 'trn_18',
        sessionId: 'tooled',
        role: 'user',
        parts: [{ id: 'p2', kind: 'toolResult', callId: 'c1', body: '12:00', failed: false }],
      },
      {
        id: 'trn_19',
        sessionId: 'tooled',
        role: 'assistant',
        parts: [{ id: 'p3', kind: 'text', body: 'noon' }],
      },
    ];
    /* The slot names a kept record the list no longer holds, which is what a
       refused `forgetAsked` after the list was written away leaves, and what an
       entry `keptIn` could not read leaves too. The newest question turn then
       has to win over the tool-results turn for the fold to happen at all. */
    storedQuestions.set('chat-asked-target:tooled', JSON.stringify({ ...words, from: 'a' }));

    await enterChat(place, 'tooled');
    await settled();

    const held = snapshotOf('tooled');
    expect(held.asked).toBeNull();
    expect(held.displaced).toEqual([]);
  });

  it('drops the kept record a stored answer already answered', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('half', place);
    /* The kept record survived a refused write while the answer landed, and the
       slot still names it. */
    const words = {
      text: 'the question asked again',
      model: 'kilo/one',
      effort: null,
      images: [],
      afterTurns: 0,
      outcome: 'failed' as const,
    };
    storedHistory = [
      {
        id: 'trn_11',
        sessionId: 'half',
        role: 'user',
        parts: [{ id: 'p1', kind: 'text', body: words.text }],
      },
      {
        id: 'trn_12',
        sessionId: 'half',
        role: 'assistant',
        parts: [{ id: 'p2', kind: 'text', body: 'the answer' }],
      },
    ];
    storedQuestions.set('chat-asked-target:half', JSON.stringify({ ...words, from: 'a' }));
    storedQuestions.set('chat-kept-questions:half', JSON.stringify([{ id: 'a', ...words }]));

    await enterChat(place, 'half');
    await settled();

    const held = snapshotOf('half');
    expect(held.asked).toBeNull();
    expect(held.displaced).toEqual([]);
    const written = await keptIn('half');
    expect(written.map(one => one.id)).toEqual([]);
  });

  it('keeps the slot question whose kept copy was never written', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('unwritten', place);
    storedQuestions.set(
      'chat-asked-target:unwritten',
      JSON.stringify({
        text: 'the question asked again',
        model: 'kilo/one',
        effort: null,
        images: [],
        from: 'a',
      })
    );

    await enterChat(place, 'unwritten');
    await settled();

    // Nothing was answered, so the question is still the one its Retry hangs off.
    const held = snapshotOf('unwritten');
    expect(held.asked).toBe('the question asked again');
    expect(asMessages(held).map(one => one.info.id)).toEqual(['unwritten:asked']);
  });

  it('draws two questions that say the same words with different pictures', async () => {
    storedHistory = [];
    await releaseChat(opened);
    storedChat('pictures', place);
    const words = { text: 'what is this', model: 'kilo/one', effort: null };
    storedQuestions.set(
      `chat-asked-target:pictures`,
      JSON.stringify({ ...words, images: [{ media: 'image/jpeg', data: 'BBBB' }] })
    );
    storedQuestions.set(
      'chat-kept-questions:pictures',
      JSON.stringify([
        {
          id: 'a',
          ...words,
          images: [{ media: 'image/jpeg', data: 'AAAA' }],
          afterTurns: 0,
          outcome: 'failed',
        },
      ])
    );

    await enterChat(place, 'pictures');
    await settled();

    // Same words, different picture: two questions, both on screen.
    expect(asMessages(snapshotOf('pictures')).map(one => one.info.id)).toEqual([
      'pictures:displaced:a',
      'pictures:asked',
    ]);
  });

  it('leaves the slot record with the question being answered when a retry only waits', async () => {
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    const kept = snapshotOf(opened).displaced[0];
    if (kept === undefined) {
      throw new TypeError('the failed question was not kept');
    }
    creditsFailureFor = undefined;
    // An answer is arriving now, with its own record in the slot.
    await say(opened, { text: 'third', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await retryChat(opened, kept);
    await settled();

    // It waits behind the answer, and the slot still records that answer's question.
    expect(snapshotOf(opened).waiting.map(one => one.text)).toEqual(['first']);
    expect(await askedIn(opened)).toEqual({
      text: 'third',
      model: 'kilo/one',
      effort: null,
      images: [],
      // The answer in front of it is a turn the store already holds.
      after: 1,
      // Nothing says why an answer still arriving failed.
      failureKey: null,
    });

    // The answer in front of it lands, so the retry is asked and becomes the slot's.
    finish?.();
    await settled();

    expect(snapshotOf(opened).waiting).toEqual([]);
    expect(await askedIn(opened)).toMatchObject({
      text: 'first',
      model: 'kilo/one',
      effort: null,
      images: [],
    });
    /* Its kept copy stays, because that bubble is the attempt on screen; the
       failure the ask pushed out of the slot took its place after it. */
    const keptAfter = await keptIn(opened);
    expect(keptAfter.map(one => one.text)).toEqual(['first', 'second']);
    expect(snapshotOf(opened).askedFrom).toBe(kept.id);
  });

  it('opens again with what a later send kept', async () => {
    creditsFailureFor = 's1';
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    await releaseChat(opened);
    await enterChat(place, opened);
    await settled();

    expect(snapshotOf(opened).displaced.map(one => one.text)).toEqual(['first']);
  });
});

describe('a chat that moved', () => {
  it('leaves the chat it moved off pointing at the one it became', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
    await settled();

    finish?.();
    await settled();

    /* The queued question moved the conversation, and nobody handed the new
       identifier back to the screen. The chat it left says where it went, so a
       screen watching the old one follows without being told. */
    expect(snapshotOf(opened).sessionId).toBe('s2');
  });

  it('keeps the transcript on screen while the screen follows the chat it became', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
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
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
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
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: 'kilo/two', effort: null });
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
    storedChat('missing', place);

    await enterChat(place, 'missing');

    expect(snapshotOf('missing').status).toBe('idle');
    expect(snapshotOf('missing').failed).toContain('no such session');
  });

  it('closes the scope it opened rather than leaking the session', async () => {
    failOpenFor = 'missing';
    storedChat('missing', place);

    await enterChat(place, 'missing');

    /* The open failed after the scope was made; with nothing holding it, only
       closing it runs the finalizers the half-open session registered. */
    expect(released).toContain('missing');
  });

  it('closes the scope when the history cannot be read', async () => {
    failHistoryFor = 'unreadable';
    storedChat('unreadable', place);

    await enterChat(place, 'unreadable');

    expect(snapshotOf('unreadable').status).toBe('idle');
    expect(released).toContain('unreadable');
  });

  it('clears the safe failure once a later entry opens the chat', async () => {
    failHistoryFor = 'flaky';
    storedChat('flaky', place);
    await enterChat(place, 'flaky');
    expect(snapshotOf('flaky').failureKey).toBe('common.somethingWentWrong');

    failHistoryFor = undefined;
    await enterChat(place, 'flaky');

    expect(snapshotOf('flaky')).toMatchObject({ status: 'idle', failureKey: null, turns: [TURN] });
  });
});

describe('opening a chat where it was recorded', () => {
  it('does not open another account’s chat, and sends nothing into it', async () => {
    await releaseChat(opened);

    await enterChat(otherAccount, opened);

    expect(snapshotOf(opened)).toMatchObject({
      status: 'idle',
      turns: [],
      failureKey: 'queryError.notFoundDescription',
    });
    expect(continued).not.toContain(opened);

    await say(opened, { text: 'into it', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    expect(asked).toEqual([]);
  });

  it('opens that chat from the place that recorded it', async () => {
    await releaseChat(opened);

    await enterChat(place, opened);
    await settled();

    expect(continued).toContain(opened);
    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', turns: [TURN], failureKey: null });
  });

  it('finishes a close before reopening the chat from its own place', async () => {
    /* The chat this run starts has no scope of its own to close, so it is let
       go and opened from the store first: the one that continues is the chat
       whose close a test can hold open. */
    await releaseChat(opened);
    await enterChat(place, opened);
    continued = [];
    released.length = 0;

    const gate = Promise.withResolvers<undefined>();
    closing = gate.promise;

    const foreign = enterChat(otherAccount, opened);
    await settled();
    expect(released).not.toContain(opened);

    const reopening = enterChat(place, opened);
    await settled();
    expect(continued).not.toContain(opened);

    gate.resolve(undefined);
    await Promise.all([foreign, reopening]);
    await settled();

    expect(released).toContain(opened);
    expect(continued).toContain(opened);
    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', turns: [TURN], failureKey: null });
  });

  it('leaves a chat a tool retry moved while the chat was being let go', async () => {
    /* The retry reads the chat, then waits on the server. The chat is let go
       from another place in that wait, and the retry lands on the session it
       moved onto after the chat has left the live ones. */
    /* The chat this run starts carries no scope of its own, so it is opened
       from the store first: the one that continues is the chat whose close a
       test can hold open. */
    await releaseChat(opened);
    await enterChat(place, opened);
    continued = [];
    released.length = 0;

    mcp.tools.push({ definition: { name: 'mcp_kilo_read-file' } });
    const server = Promise.withResolvers<undefined>();
    mcp.ensure.mockImplementationOnce(async () => {
      await server.promise;
      return { status: 'ready' as const, tools: mcp.tools };
    });
    const retrying = retryKiloMcp(opened);
    await settled();

    const gate = Promise.withResolvers<undefined>();
    closing = gate.promise;
    const foreign = enterChat(otherAccount, opened);
    await settled();

    server.resolve(undefined);
    await settled();
    const carried = snapshotOf(opened).sessionId;
    expect(carried).toBe('s2');

    gate.resolve(undefined);
    await Promise.all([foreign, retrying]);
    await settled();

    /* The let-go id settles for itself and says nothing about the chat that
       carried on: that one is live, and it keeps its transcript. */
    expect(snapshotOf(carried)).toMatchObject({
      status: 'idle',
      turns: [TURN],
      failureKey: null,
    });
    await releaseChat(carried);
  });

  it('keeps an organization’s chat out of the personal place', async () => {
    storedChat('org-chat', otherOrganization);

    await enterChat(place, 'org-chat');
    await settled();

    expect(snapshotOf('org-chat')).toMatchObject({
      status: 'idle',
      turns: [],
      failureKey: 'queryError.notFoundDescription',
    });

    await enterChat(otherOrganization, 'org-chat');
    await settled();

    expect(continued).toContain('org-chat');
    expect(snapshotOf('org-chat')).toMatchObject({ turns: [TURN], failureKey: null });
    await releaseChat('org-chat');
  });

  it('opens a chat a model switch moved, on the id it moved to', async () => {
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/two', effort: null });
    await settled();
    finish?.();
    await settled();

    const carried = snapshotOf(opened).sessionId;
    expect(carried).toBe('s2');
    await releaseChat(carried);

    await enterChat(place, carried);
    await settled();

    expect(snapshotOf(carried)).toMatchObject({ status: 'idle', turns: [TURN], failureKey: null });
  });

  it('ends a chat another place left running instead of handing it over', async () => {
    /* The chat is live, started in `place` before this test. Entering it from
       another place ends it there: the answer it was on stops, and no question
       reaches its session from here. */
    await enterChat(otherAccount, opened);
    await settled();

    expect(snapshotOf(opened)).toMatchObject({
      status: 'idle',
      turns: [],
      failureKey: 'queryError.notFoundDescription',
    });

    await say(opened, { text: 'into it', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    expect(asked).toEqual([]);

    /* Nothing is held for it any more, so its own place opens it again from
       the store rather than finding the session this place would have kept. */
    await enterChat(place, opened);
    await settled();
    expect(continued).toContain(opened);
  });

  it('settles the state even when the chat cannot be ended', async () => {
    /* Ending it closes the scope that writes the conversation down, and that
       close can fail. The chat is let go either way: nothing of it is drawn
       here, and no question asked here reaches its session. */
    backendState.failNext = true;

    await enterChat(otherAccount, opened);
    await settled();

    expect(snapshotOf(opened)).toMatchObject({
      status: 'idle',
      turns: [],
      failureKey: 'queryError.notFoundDescription',
    });

    await say(opened, { text: 'into it', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    expect(asked).toEqual([]);
  });

  it('does not open an id the store never recorded', async () => {
    await enterChat(place, 'unrecorded');

    expect(continued).not.toContain('unrecorded');
    expect(snapshotOf('unrecorded')).toMatchObject({
      status: 'idle',
      turns: [],
      failureKey: 'queryError.notFoundDescription',
    });
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
    storedChat('later', place);
    const entering = enterChat(place, 'later');
    await say('later', { text: 'typed early', images: [] }, { model: 'kilo/one', effort: null });
    await entering;
    await settled();

    expect(asked).toEqual([{ sessionId: 'later', text: 'typed early' }]);
  });

  it('says so rather than reporting success when the chat is not there', async () => {
    await releaseChat(opened);
    asked.length = 0;

    await say(opened, { text: 'into nothing', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(asked).toEqual([]);
    /* The question is on screen with a Retry under it, which is what every
       other question that never reached the model gets. */
    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', asked: 'into nothing' });
    expect(snapshotOf(opened).failed).not.toBeNull();
  });
});

describe('the effort a chat asks with', () => {
  it('moves the chat onto the effort a question is asked with', async () => {
    await say(opened, { text: 'think hard', images: [] }, { model: 'kilo/one', effort: 'high' });
    await settled();

    expect(clonedWith).toEqual({ effort: 'high' });
    expect(snapshotOf(opened)).toMatchObject({ sessionId: 's2', effort: 'high' });
    expect(asked.at(-1)).toEqual({ sessionId: 's2', text: 'think hard' });
  });

  it('reports the effort it moved onto in the record the details sheet reads', async () => {
    await say(opened, { text: 'think hard', images: [] }, { model: 'kilo/one', effort: 'high' });
    await settled();

    expect(snapshotOf(opened).record.effort).toBe('high');
  });

  it('reports the model default after a move back onto it', async () => {
    change(opened, { effort: 'high', record: { ...snapshotOf(opened).record, effort: 'high' } });

    await say(opened, { text: 'plain', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(snapshotOf(opened).record.effort).toBeNull();
  });

  it('moves back onto the model default when the effort is cleared', async () => {
    change(opened, { effort: 'high' });

    await say(opened, { text: 'plain', images: [] }, { model: 'kilo/one', effort: null });
    await settled();

    expect(clonedWith).toEqual({ effort: 'default' });
    expect(snapshotOf(opened).effort).toBeNull();
  });

  it('keeps the session when the question asks with the effort it already has', async () => {
    change(opened, { effort: 'low' });

    await say(opened, { text: 'again', images: [] }, { model: 'kilo/one', effort: 'low' });
    await settled();

    expect(clonedWith).toBeUndefined();
    expect(asked.at(-1)).toEqual({ sessionId: 's1', text: 'again' });
  });

  it('reopens a stored chat with the effort it was opened with', async () => {
    await releaseChat(opened);
    storedEffort = 'medium';
    storedChat('stored', place);

    await enterChat(place, 'stored');

    expect(snapshotOf('stored')).toMatchObject({ status: 'idle', effort: 'medium' });
    await releaseChat('stored');
  });

  it('asks a retry with the effort the question was asked with', async () => {
    change(opened, { effort: 'high' });
    failAnswerFor = 's1';
    await say(opened, { text: 'think hard', images: [] }, { model: 'kilo/one', effort: 'high' });
    await settled();
    failAnswerFor = undefined;
    /* The chat is back on the default, so only the remembered effort can move it. */
    change(opened, { effort: null });

    await retryChat(opened);
    await settled();

    expect(clonedWith).toEqual({ effort: 'high' });
    expect(asked.at(-1)).toEqual({ sessionId: 's2', text: 'think hard' });
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
    models: [{ id: 'same-model', name: 'Model', tools: false, images: false, reasoning: false }],
    allowLocalHttp: false,
  };

  it('drops all tool definitions when a queued question moves onto a text-only backend', async () => {
    backendState.profiles = [backend];
    storedTools = [...BASE, ...SETTINGS];
    const target = backendTargetId(backend, 'same-model');
    await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: target, effort: null });
    expect(waitingWords(opened)).toEqual(['second']);
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
      await say(opened, { text: 'first', images: [] }, { model: 'kilo/one', effort: null });
      await settled();
      await say(opened, { text: 'custom question', images: [] }, { model: target, effort: null });
      expect(waitingWords(opened)).toEqual(['custom question']);

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
      expect(await askedIn(opened)).toEqual({
        text: 'custom question',
        model: target,
        effort: null,
        images: [],
        after: 1,
        failureKey: errorKey,
      });

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
      opened = await startChat(place, { model: target, effort: null });
      await say(opened, { text: 'first', images: [] }, { model: target, effort: null });
      await settled();
      await say(
        opened,
        { text: 'queued custom question', images: [] },
        { model: target, effort: null }
      );
      await say(
        opened,
        { text: 'queued Kilo question', images: [] },
        { model: 'kilo/one', effort: null }
      );
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
        waiting: [
          { text: 'queued custom question', images: [] },
          { text: 'queued Kilo question', images: [] },
        ],
        failed: i18n.t(errorKey),
        failureKey: errorKey,
      });

      // Retry reattempts the tool move without losing either queued target.
      await retryChat(opened);
      expect(snapshotOf(opened).failed).toBe(i18n.t(errorKey));
      expect(waitingWords(opened)).toEqual(['queued custom question', 'queued Kilo question']);
      expect(asked).toHaveLength(1);

      // Only an explicit valid choice can move off the invalid backend.
      await say(
        opened,
        { text: 'explicit Kilo recovery', images: [] },
        { model: 'kilo/one', effort: null }
      );
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
        waiting: [{ text: 'queued Kilo question', images: [] }],
        failed: i18n.t(errorKey),
        failureKey: errorKey,
      });
      expect(await askedIn(snapshotOf(opened).sessionId)).toEqual({
        text: 'queued custom question',
        model: target,
        effort: null,
        images: [],
        after: 1,
        failureKey: errorKey,
      });
      await retryChat(opened);
      expect(asked).toHaveLength(2);
      expect(snapshotOf(opened).askedModel).toBe(target);

      await say(
        opened,
        { text: 'explicit replacement question', images: [] },
        { model: 'kilo/one', effort: null }
      );
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
    opened = await startChat(place, { model: target, effort: null });
    await say(opened, { text: 'first', images: [] }, { model: target, effort: null });
    await settled();
    await say(opened, { text: 'second', images: [] }, { model: target, effort: null });
    await refreshChatTools();
    backendState.profiles = [];
    finish?.();
    await settled();
    expect(snapshotOf(opened).failed).toBe(i18n.t('modelChat.backends.deletedBackend'));
    expect(waitingWords(opened)).toEqual(['second']);

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

    await say(opened, { text: 'custom question', images: [] }, { model: target, effort: null });

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
    expect(await askedIn('s2')).toEqual({
      text: 'custom question',
      model: target,
      effort: null,
      images: [],
      failureKey: 'common.somethingWentWrong',
    });

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

    await say(opened, { text: 'custom question', images: [] }, { model: target, effort: null });
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
    expect(await askedIn('s2')).toEqual({
      text: 'custom question',
      model: target,
      effort: null,
      images: [],
      failureKey: 'common.somethingWentWrong',
    });

    backendState.profiles = [];
    await retryChat(opened);
    await settled();

    expect(asked).toEqual([{ sessionId: 's2', text: 'custom question' }]);
    expect(snapshotOf(opened).failed).toBe(i18n.t('modelChat.backends.deletedBackend'));
  });

  it('replaces a failed question target when the person asks a different question', async () => {
    const target = backendTargetId(backend, 'same-model');
    await say(
      opened,
      { text: 'invalid custom question', images: [] },
      { model: target, effort: null }
    );
    expect(snapshotOf(opened).askedModel).toBe(target);

    await say(
      opened,
      { text: 'a new Kilo question', images: [] },
      { model: 'kilo/one', effort: null }
    );
    await settled();
    expect(await askedIn(opened)).toEqual({
      text: 'a new Kilo question',
      model: 'kilo/one',
      effort: null,
      images: [],
      failureKey: null,
    });
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
    expect(await askedIn(opened)).toEqual({
      text,
      model: 'kilo/one',
      effort: null,
      images: [],
      failureKey: null,
    });
    expect(storedQuestions.has(`chat-asked:${opened}`)).toBe(false);
    expect(storedQuestions.get(`chat-asked-target:${opened}`)).toBe(
      JSON.stringify({ text, model: 'kilo/one', effort: null, images: [], failureKey: null })
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
      effort: null,
      images: [],
      failureKey: null,
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
    await say(
      opened,
      { text: 'invalid custom question', images: [] },
      { model: target, effort: null }
    );
    storedQuestions.set(`chat-asked:${opened}`, 'old question');

    await releaseChat(opened);
    await forgetAsked(opened);
    await enterChat(place, opened);

    expect(await askedIn(opened)).toBeNull();
    expect(storedQuestions.has(`chat-asked:${opened}`)).toBe(false);
    expect(snapshotOf(opened)).toMatchObject({ asked: null, askedModel: null });
  });
});

describe('what a chat has used', () => {
  const answer = async (text: string, model: string) => {
    await say(opened, { text, images: [] }, { model, effort: null });
    await settled();
    finish?.();
    await settled();
  };

  it('counts each answer under its model and writes it down as the answer ends', async () => {
    await answer('one', 'kilo/one');
    await answer('two', 'kilo/one');

    const twice = { ...CALL, inputTokens: 20, outputTokens: 4, cacheReadTokens: 180, cost: 0.02 };
    expect(snapshotOf(opened).record).toMatchObject({
      usage: { 'kilo/one': twice },
      prompted: 102,
    });
    expect(recorded.get('s1')).toEqual({ 'kilo/one': twice });
  });

  it('keeps counting across a model switch, which opens a session counting from zero', async () => {
    await answer('one', 'kilo/one');
    await answer('two', 'kilo/two');

    expect(snapshotOf(opened).sessionId).toBe('s2');
    expect(snapshotOf(opened).record.usage).toEqual({ 'kilo/one': CALL, 'kilo/two': CALL });
    expect(recorded.get('s2')).toEqual({ 'kilo/one': CALL, 'kilo/two': CALL });
  });

  it('reads the count back when a stored chat is opened again', async () => {
    await answer('one', 'kilo/one');
    await releaseChat(opened);

    await enterChat(place, opened);
    await answer('two', 'kilo/one');

    expect(snapshotOf(opened).record.usage['kilo/one']).toMatchObject({
      inputTokens: 20,
      cost: 0.02,
    });
  });

  it('keeps the answer and the count when writing the count fails', async () => {
    recordFailure.next = true;
    await answer('one', 'kilo/one');

    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', failed: null, failureKey: null });
    expect(snapshotOf(opened).record.usage).toEqual({ 'kilo/one': CALL });

    await answer('two', 'kilo/one');
    expect(recorded.get('s1')).toMatchObject({ 'kilo/one': { inputTokens: 20 } });
  });

  it('records routed tool rounds and summaries without replacing Auto, and retains them on reopen', async () => {
    await releaseChat(opened);
    const auto = 'kilo-auto/balanced';
    opened = await startChat(place, { model: auto, effort: null });
    await say(opened, { text: 'use a tool', images: [] }, { model: auto, effort: null });
    await settled();
    const current = snapshotOf(opened).sessionId;
    routedTotals.set(current, new Map([['vendor/first', CALL]]));
    emitEvent?.({ kind: 'done', model: 'vendor/first', usage: CALL, stop: 'tools' });
    await settled();
    expect(snapshotOf(opened).record.usage).toEqual({ 'vendor/first': CALL });
    expect(snapshotOf(opened).model).toBe(auto);

    const second = { ...CALL, inputTokens: 20, cost: 0.02 };
    const summary = { ...CALL, inputTokens: 30, cost: 0.003 };
    const expected = { 'vendor/first': CALL, 'vendor/second': second, 'vendor/summary': summary };
    routedTotals.set(current, new Map(Object.entries(expected)));
    emitEvent?.({ kind: 'done', model: 'vendor/second', usage: second, stop: 'end' });
    await settled();
    finish?.();
    await settled();

    expect(snapshotOf(opened).model).toBe(auto);
    expect(snapshotOf(opened).record.usage).toEqual(expected);
    expect(recorded.get(current)).toEqual(expected);
    await releaseChat(opened);
    await enterChat(place, current);
    expect(snapshotOf(current).record.usage).toEqual(expected);
    await answer('next model', 'kilo/one');
    expect(snapshotOf(current).record.usage).toEqual({ ...expected, 'kilo/one': CALL });
  });

  it('persists a completed summary even when no answer done event follows it', async () => {
    routedTotals.set(opened, new Map([['vendor/summary', CALL]]));
    failAnswerFor = opened;

    await say(
      opened,
      { text: 'after compaction', images: [] },
      { model: 'kilo/one', effort: null }
    );
    await settled();

    expect(snapshotOf(opened)).toMatchObject({ status: 'idle' });
    expect(snapshotOf(opened).failed).not.toBeNull();
    expect(snapshotOf(opened).record.usage).toEqual({ 'vendor/summary': CALL });
    expect(recorded.get(opened)).toEqual({ 'vendor/summary': CALL });
  });
});

describe('remote servers after a restart', () => {
  /* A registry imported again holds no chat and nothing discovered, which is
     what the app holds after it restarts. */
  beforeEach(() => {
    vi.resetModules();
  });

  const ALPHA = { definition: { name: 'mcp_alpha_read' } };

  it('discovers the remote servers when a chat starts, so it offers their tools', async () => {
    const fresh = await import('./registry');
    remote.offered.push(ALPHA);

    const started = await fresh.startChat(place, { model: 'kilo/one', effort: null });

    expect(remote.ensure).toHaveBeenCalledWith(place);
    expect(openedWith?.tools).toContain('mcp_alpha_read');
    await fresh.releaseChat(started);
  });

  it('discovers the remote servers before a stored chat continues on their names', async () => {
    const fresh = await import('./registry');
    remote.offered.push(ALPHA);
    continuesWith = ['mcp_alpha_read'];
    storedChat('s9', place);

    await fresh.enterChat(place, 's9');

    expect(remote.ensure).toHaveBeenCalledWith(place);
    // The stored names resolved, so the chat continued rather than being moved.
    expect(clonedWith).toBeUndefined();
    await fresh.releaseChat('s9');
  });
});

describe('tool visibility while reading', () => {
  it('publishes pending, running and resolved tools in order, then restores them after reopening', async () => {
    await say(opened, { text: 'check today', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    emitEvent?.({
      kind: 'toolCall',
      call: { id: 'c1', name: 'web_search', arguments: '{"query":"today"}' },
    });
    await settled();
    expect(asMessages(snapshotOf(opened)).at(-1)?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'ok' }),
      expect.objectContaining({
        type: 'tool',
        tool: 'web_search',
        state: expect.objectContaining({ status: 'pending', input: { query: 'today' } }),
      }),
    ]);
    emitEvent?.({
      kind: 'done',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: 'tools',
    });
    await settled();
    expect(snapshotOf(opened).answering[1]).toMatchObject({ state: { status: 'running' } });
    emitEvent?.({
      kind: 'toolResult',
      result: { callId: 'c1', body: 'today’s news', failed: false },
    });
    emitEvent?.({ kind: 'delta', text: 'Here is the news.' });
    await settled();
    const live = asMessages(snapshotOf(opened)).at(-1);
    expect(live?.parts.map(part => part.type)).toEqual(['text', 'tool', 'text']);
    expect(live?.parts[1]).toMatchObject({
      state: { status: 'completed', input: { query: 'today' }, output: 'today’s news' },
    });
    storedHistory = [
      {
        id: 't1',
        sessionId: opened,
        role: 'user',
        parts: [{ id: 'p1', kind: 'text', body: 'check today' }],
      },
      {
        id: 't2',
        sessionId: opened,
        role: 'assistant',
        parts: [
          { id: 'p2', kind: 'text', body: 'ok' },
          {
            id: 'p3',
            kind: 'toolCall',
            callId: 'c1',
            name: 'web_search',
            body: '{"query":"today"}',
          },
        ],
      },
      {
        id: 't3',
        sessionId: opened,
        role: 'user',
        parts: [
          { id: 'p4', kind: 'toolResult', callId: 'c1', body: 'today’s news', failed: false },
        ],
      },
      {
        id: 't4',
        sessionId: opened,
        role: 'assistant',
        parts: [{ id: 'p5', kind: 'text', body: 'Here is the news.' }],
      },
    ];
    finish?.();
    await settled();
    expect(snapshotOf(opened)).toMatchObject({ status: 'idle', answering: [], asked: null });
    const stored = asMessages(snapshotOf(opened));
    expect(stored.map(message => message.parts.map(part => part.type))).toEqual([
      ['text'],
      ['text', 'tool'],
      ['text'],
    ]);
    await releaseChat(opened);
    await enterChat(place, opened);
    expect(asMessages(snapshotOf(opened))).toEqual(stored);
  });

  it('shows a failed tool without failing the answer or adding a result bubble', async () => {
    await say(opened, { text: 'what time is it', images: [] }, { model: 'kilo/one', effort: null });
    await settled();
    emitEvent?.({ kind: 'toolCall', call: { id: 'c1', name: 'time', arguments: '{}' } });
    emitEvent?.({
      kind: 'toolResult',
      result: { callId: 'c1', body: 'clock unavailable', failed: true },
    });
    await settled();
    expect(snapshotOf(opened)).toMatchObject({ status: 'working', failureKey: null });
    const live = asMessages(snapshotOf(opened));
    expect(live).toHaveLength(2);
    expect(live.at(-1)?.parts[1]).toMatchObject({
      type: 'tool',
      state: { status: 'error', input: {}, error: 'clock unavailable' },
    });
    finish?.();
    await settled();
  });
});
