import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpFailure,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { type ChatPlace } from './scope';

/**
 * The Kilo MCP connection, derived from the session the app already has.
 *
 * What is worth proving here is not the transport — the harness plugin owns it
 * and its own suite proves it against a real server. It is what this app does
 * around it: the URL it builds, the token it reads, that one account's tools
 * are never served to the next, and that a chat's own on/off setting is kept
 * and carried across a model switch.
 *
 * The plugin is faked because none of it is about the protocol: what is under
 * test is the module's own caching, its state machine, and its preferences.
 */

type Discovery = { readonly server: RemoteMcpServer; readonly deps: RemoteMcpClientDeps };

const world = vi.hoisted(() => ({
  config: { KILO_MCP_URL: 'https://mcp.example' as string | undefined },
  epoch: 0,
  token: vi.fn(async () => {
    await Promise.resolve();
    return 'token-one' as string | null;
  }),
  calls: [] as Discovery[],
  tokensUsed: [] as string[],
  settings: new Map<string, string>(),
}));

vi.mock('@/lib/config', () => world.config);
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: world.token }));
vi.mock('@/lib/auth/auth-epoch', () => ({ currentAuthEpoch: () => world.epoch }));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, k: string) => {
    await Promise.resolve();
    return world.settings.get(`${scope}\u0000${k}`) ?? null;
  },
  removeItem: async (scope: string, k: string) => {
    await Promise.resolve();
    world.settings.delete(`${scope}\u0000${k}`);
  },
  setItem: async (scope: string, k: string, v: string) => {
    await Promise.resolve();
    world.settings.set(`${scope}\u0000${k}`, v);
  },
}));

/**
 * The plugin, answering from one function so a test can make it fail.
 *
 * The token is read the way the real client reads it — through the accessor,
 * at the moment of discovery — so a test can prove the module reconnects with
 * whatever token answers then rather than the one the process started with.
 */
vi.mock('@kilocode/harness-sdk/plugins/remote-mcp', () => ({
  RemoteMcpError: class FakeRemoteMcpError extends Error {
    readonly kind: RemoteMcpFailure;
    constructor(fields: {
      readonly serverId: string;
      readonly kind: RemoteMcpFailure;
      readonly cause: unknown;
    }) {
      super(`${fields.serverId}: ${fields.kind}`);
      this.name = 'RemoteMcpError';
      this.kind = fields.kind;
    }
  },
  remoteMcpTools: (server: RemoteMcpServer, deps: RemoteMcpClientDeps) => {
    world.calls.push({ server, deps });
    return answer(deps);
  },
}));

/** The one tool the fake server offers, named the way the harness names it. */
const tool: Tool = {
  definition: {
    name: 'mcp_kilo_read-file',
    description: 'Reads one file.',
    parameters: { type: 'object', properties: {} },
  },
  run: () => Effect.succeed(''),
};

/** A discovery that answers with the tool, having read the credential first. */
const discovering = (deps: RemoteMcpClientDeps): Effect.Effect<readonly Tool[], RemoteMcpError> =>
  Effect.gen(function* reading() {
    const read = deps.token;
    if (read !== undefined) {
      world.tokensUsed.push(yield* read());
    }
    return [tool];
  });

let answer: (deps: RemoteMcpClientDeps) => Effect.Effect<readonly Tool[], RemoteMcpError> =
  discovering;

const {
  ensureKiloMcp,
  forgetKiloMcp,
  forgetMcpEnabled,
  kiloMcpState,
  kiloMcpToolNames,
  kiloMcpTools,
  mcpEnabledFor,
  moveMcpEnabled,
  setMcpEnabled,
  watchKiloMcp,
} = await import('./kilo-mcp');

const place: ChatPlace = { chatScope: 'user-1:personal', org: { kind: 'personal' } };

const refusing = (kind: RemoteMcpFailure) => () =>
  Effect.fail(new RemoteMcpError({ serverId: 'kilo', kind, cause: 'the server said no' }));

beforeEach(() => {
  world.config.KILO_MCP_URL = 'https://mcp.example';
  world.epoch = 0;
  world.token.mockReset();
  world.token.mockResolvedValue('token-one');
  world.calls.length = 0;
  world.tokensUsed.length = 0;
  world.settings.clear();
  answer = discovering;
  forgetKiloMcp();
});

describe('discovering the Kilo server', () => {
  it('derives the server from the session and exposes the tools it names', async () => {
    const state = await ensureKiloMcp(place);

    expect(state).toEqual({ status: 'ready', tools: [tool] });
    expect(kiloMcpTools()).toEqual([tool]);
    expect(kiloMcpToolNames()).toEqual(['mcp_kilo_read-file']);
    expect(world.calls[0]?.server).toEqual({
      id: 'kilo',
      name: 'Kilo tools',
      url: 'https://mcp.example/mcp',
      auth: { type: 'bearer' },
    });
    expect(world.tokensUsed).toEqual(['token-one']);
  });

  it('does not reconnect while the answer still stands', async () => {
    await ensureKiloMcp(place);
    await ensureKiloMcp(place);

    expect(world.calls).toHaveLength(1);
  });

  it('asks again after an answer with no tools, rather than latching it', async () => {
    /* The empty sheet offers no Retry, so an empty answer kept as the account's
       answer would leave every chat after it on "No tools available". The next
       chat reconnects and says what the server offers now. */
    answer = () => Effect.succeed([]);
    await ensureKiloMcp(place);

    answer = discovering;
    const state = await ensureKiloMcp(place);

    expect(state).toEqual({ status: 'ready', tools: [tool] });
    expect(world.calls).toHaveLength(2);
  });

  it('joins a discovery already running rather than opening a second one', async () => {
    const [first, second] = await Promise.all([ensureKiloMcp(place), ensureKiloMcp(place)]);

    expect(world.calls).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it('stays idle and reaches no server when the build carries no URL', async () => {
    world.config.KILO_MCP_URL = undefined;

    const state = await ensureKiloMcp(place);

    expect(state).toEqual({ status: 'idle' });
    expect(kiloMcpState()).toEqual({ status: 'idle' });
    expect(world.calls).toHaveLength(0);
  });

  it('never serves an answer cached for the account that signed out', async () => {
    await ensureKiloMcp(place);
    world.epoch += 1;

    await ensureKiloMcp(place);

    expect(world.calls).toHaveLength(2);
  });
});

describe('a server that says no', () => {
  it.each([
    ['unreachable', true],
    ['unauthorized', true],
    ['protocol', true],
    ['missing', false],
  ] as const)('reports %s as retryable=%s', async (kind, retryable) => {
    answer = refusing(kind);

    const state = await ensureKiloMcp(place);

    expect(state).toEqual({ status: 'failed', kind, retryable });
  });

  it('gives a person a Retry the longer deadline, because they asked for it', async () => {
    answer = refusing('unreachable');
    await ensureKiloMcp(place);
    answer = discovering;

    await ensureKiloMcp(place, 'retry');

    expect(world.calls.map(call => call.deps.discoverTimeoutMs)).toEqual([4000, 15_000]);
    /* The chat-open number bounds discovery only. A tool call keeps the
       harness's own bound, so no call is handed the app's deadline. */
    expect(world.calls.map(call => 'timeoutMs' in call.deps)).toEqual([false, false]);
  });

  it('keeps an open at four seconds even after a failure, so the chat is never held', async () => {
    answer = refusing('unreachable');
    await ensureKiloMcp(place);
    answer = discovering;

    /* The deadline is the caller's, not the last answer's: an open that follows
       a retryable failure reconnects with four seconds, not the Retry's
       fifteen, or the send waits on a server instead of opening the chat. */
    await ensureKiloMcp(place, 'automatic');

    expect(world.calls.map(call => call.deps.discoverTimeoutMs)).toEqual([4000, 4000]);
  });
});

describe('forgetting the connection', () => {
  it('reconnects and reads the token that answers then', async () => {
    await ensureKiloMcp(place);
    forgetKiloMcp();
    world.token.mockResolvedValue('token-two');

    await ensureKiloMcp(place);

    expect(world.calls).toHaveLength(2);
    expect(world.tokensUsed).toEqual(['token-one', 'token-two']);
  });

  it('leaves nothing on screen for the account that left', async () => {
    await ensureKiloMcp(place);

    forgetKiloMcp();

    expect(kiloMcpState()).toEqual({ status: 'idle' });
    expect(kiloMcpTools()).toEqual([]);
    expect(kiloMcpToolNames()).toEqual([]);
  });
});

describe('the snapshot a screen draws', () => {
  it('says it is connecting, then shows the tools', async () => {
    const seen: string[] = [];
    const stop = watchKiloMcp(() => {
      seen.push(kiloMcpState().status);
    });

    await ensureKiloMcp(place);
    stop();

    expect(seen).toEqual(['connecting', 'ready']);
  });

  it('draws the answer it serves from the cache, over another scope that is connecting', async () => {
    await ensureKiloMcp(place);
    const gate: { release?: () => void } = {};
    answer = () =>
      Effect.async<readonly Tool[], RemoteMcpError>(resume => {
        gate.release = () => {
          resume(Effect.succeed([tool]));
        };
      });
    const other = ensureKiloMcp({ ...place, chatScope: 'user-1:org-1' });
    expect(kiloMcpState()).toEqual({ status: 'connecting' });

    await ensureKiloMcp(place);

    /* The registry builds a chat from the snapshot, so a cached answer that is
       served but not drawn opens the chat on the base tools. */
    expect(kiloMcpState()).toEqual({ status: 'ready', tools: [tool] });
    gate.release?.();
    await other;
  });
});

describe('a call that could not reach the server', () => {
  /** The failure callback the plugin was handed for the discovery just made. */
  const lost = (): ((error: RemoteMcpError) => void) | undefined =>
    world.calls.at(-1)?.deps.onCallFailure;

  it('turns the connection into the failure the screen draws', async () => {
    await ensureKiloMcp(place);
    expect(kiloMcpState()).toEqual({ status: 'ready', tools: [tool] });

    const fail = lost();
    expect(fail).toBeDefined();
    fail?.(new RemoteMcpError({ serverId: 'kilo', kind: 'unreachable', cause: 'it is gone' }));

    /* The dot turns red and the Retry is offered, rather than the sheet
       counting tools while every call fails. */
    expect(kiloMcpState()).toEqual({ status: 'failed', kind: 'unreachable', retryable: true });
    expect(kiloMcpTools()).toEqual([]);
  });

  it('reconnects on Retry rather than serving the list that just failed', async () => {
    await ensureKiloMcp(place);
    lost()?.(new RemoteMcpError({ serverId: 'kilo', kind: 'unreachable', cause: 'it is gone' }));

    await ensureKiloMcp(place, 'retry');

    expect(world.calls).toHaveLength(2);
    expect(kiloMcpState()).toEqual({ status: 'ready', tools: [tool] });
  });

  it('keeps the failure when the server is not there any more, with no Retry', async () => {
    await ensureKiloMcp(place);

    lost()?.(new RemoteMcpError({ serverId: 'kilo', kind: 'missing', cause: 'it is gone' }));

    expect(kiloMcpState()).toEqual({ status: 'failed', kind: 'missing', retryable: false });
  });

  it('does not publish a failure that outlived the sign-out', async () => {
    await ensureKiloMcp(place);
    const fail = lost();

    forgetKiloMcp();
    fail?.(new RemoteMcpError({ serverId: 'kilo', kind: 'unreachable', cause: 'it is gone' }));

    expect(kiloMcpState()).toEqual({ status: 'idle' });
  });
});

describe('the per-chat setting', () => {
  it('is on unless the person turned it off', async () => {
    expect(await mcpEnabledFor('chat-1')).toBe(true);

    await setMcpEnabled('chat-1', false);
    expect(await mcpEnabledFor('chat-1')).toBe(false);

    await setMcpEnabled('chat-1', true);
    expect(await mcpEnabledFor('chat-1')).toBe(true);
  });

  it('moves with the chat when a model switch opens a new session', async () => {
    await setMcpEnabled('old', false);

    await moveMcpEnabled('old', 'new');

    expect(await mcpEnabledFor('new')).toBe(false);
    expect(await mcpEnabledFor('old')).toBe(true);
  });

  it('is dropped with the chats it belongs to', async () => {
    await setMcpEnabled('gone', false);

    await forgetMcpEnabled(['gone']);

    expect(await mcpEnabledFor('gone')).toBe(true);
  });
});
