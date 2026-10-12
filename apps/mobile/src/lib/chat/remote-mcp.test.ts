import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { place, server, stateOf, tool } from './remote-mcp.test-helpers';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The stored remote MCP servers, discovered for the tools they offer.
 *
 * The store is faked so the module's own subscription — the thing that drops a
 * disabled server's tools — can be driven without a device.
 */

const world = vi.hoisted(() => ({
  servers: [] as StoredRemoteMcpServer[],
  epoch: 0,
  calls: [] as {
    readonly server: RemoteMcpServer;
    readonly deps: RemoteMcpClientDeps;
  }[],
  listeners: [] as (() => void)[],
  /** Whether the stored list has been read, and what reading it later does. */
  loaded: true,
  load: undefined as (() => void) | undefined,
  connectivity: 'online' as 'online' | 'offline' | 'unknown',
}));

vi.mock('./remote-mcp-store', () => ({
  listRemoteMcpServers: () => world.servers,
  subscribeRemoteMcpServers: (listener: () => void) => {
    world.listeners.push(listener);
    return () => {
      world.listeners = world.listeners.filter(current => current !== listener);
    };
  },
  getRemoteMcpServersHasLoaded: () => world.loaded,
  whenRemoteMcpServersLoaded: async () => {
    await new Promise<void>(resolve => {
      world.load = resolve;
    });
  },
}));

vi.mock('@/lib/auth/auth-epoch', () => ({ currentAuthEpoch: () => world.epoch }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => world.connectivity,
}));

/** The one discovery function, answering from a `let` so a test can change it. */
let answer: () => Effect.Effect<readonly Tool[], RemoteMcpError> = () => Effect.succeed([]);

vi.mock('@kilocode/harness-sdk/plugins/remote-mcp', () => ({
  RemoteMcpError: class FakeRemoteMcpError extends Error {
    readonly kind: string;
    constructor(fields: {
      readonly serverId: string;
      readonly kind: string;
      readonly cause: unknown;
    }) {
      super(`${fields.serverId}: ${fields.kind}`);
      this.name = 'RemoteMcpError';
      this.kind = fields.kind;
    }
  },
  remoteMcpTools: (held: RemoteMcpServer, deps: RemoteMcpClientDeps) => {
    world.calls.push({ server: held, deps });
    return answer();
  },
}));

const {
  ensureRemoteMcp,
  forgetRemoteMcp,
  remoteMcpState,
  remoteServerToolNames,
  remoteServerTools,
} = await import('./remote-mcp');

/** What the app does when the stored list changes. */
function emitServers(): void {
  for (const listener of world.listeners) {
    listener();
  }
}

beforeEach(() => {
  world.servers = [];
  world.epoch = 0;
  world.calls.length = 0;
  world.loaded = true;
  world.load = undefined;
  answer = () => Effect.succeed([tool('mcp_alpha_read')]);
  world.connectivity = 'online';
  forgetRemoteMcp();
});

describe('the discovered state', () => {
  it('discovers an enabled server and exposes the tools it offers', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];

    await ensureRemoteMcp(place);

    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
    ]);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read']);
    expect(world.calls[0]?.deps.discoverTimeoutMs).toBe(4000);
  });

  it('shows a running discovery as connecting before it answers', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];

    const running = ensureRemoteMcp(place);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'connecting', toolCount: 0, retryable: false }),
    ]);

    await running;
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
    ]);
  });

  it('gives a person’s Retry the longer deadline', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];

    await ensureRemoteMcp(place, { retry: true });

    expect(world.calls[0]?.deps.discoverTimeoutMs).toBe(15_000);
  });

  it('sends the stored token for a bearer server and none for an open one', async () => {
    const open = server({ id: 'alpha' });
    const bearer = server({ id: 'beta', auth: { type: 'bearer', token: 'secret' } });
    world.servers = [open, bearer];

    await ensureRemoteMcp(place);

    const byId = new Map(world.calls.map(call => [call.server.id, call.deps]));
    expect(byId.get('alpha')?.token).toBeUndefined();
    const readToken = byId.get('beta')?.token;
    expect(readToken).toBeDefined();
    if (readToken !== undefined) {
      expect(await Effect.runPromise(readToken())).toBe('secret');
    }
  });

  it('reads the stored token at call time, never the one captured at discovery', async () => {
    world.servers = [server({ id: 'beta', auth: { type: 'bearer', token: 'old' } })];
    await ensureRemoteMcp(place);

    const readToken = world.calls[0]?.deps.token;
    expect(readToken).toBeDefined();
    expect(world.calls).toHaveLength(1);

    world.servers = [server({ id: 'beta', auth: { type: 'bearer', token: 'new' } })];
    if (readToken !== undefined) {
      expect(await Effect.runPromise(readToken())).toBe('new');
    }
    await ensureRemoteMcp(place);
    expect(world.calls).toHaveLength(1);
  });

  it('asks again when the account changes, never serving the old answer', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    await ensureRemoteMcp(place);

    world.epoch += 1;
    await ensureRemoteMcp(place);

    expect(world.calls).toHaveLength(2);
  });

  it('never lets a superseded config’s discovery publish over the newer one', async () => {
    /* The first server's discovery is held open, so the config can change while
       it is still out. */
    const gate: { open?: () => void } = {};
    const held = new Promise<void>(resolve => {
      gate.open = resolve;
    });
    let call = 0;
    answer = () => {
      call += 1;
      if (call > 1) {
        return Effect.succeed([tool('mcp_alpha_write')]);
      }
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the promise settles when the test releases it, not on an await
      return Effect.promise(() => held).pipe(Effect.map(() => [tool('mcp_alpha_read')]));
    };

    world.servers = [server({ id: 'alpha', url: 'https://old.example/mcp' })];
    const superseded = ensureRemoteMcp(place);

    /* The person edits the server while the old discovery is still out. */
    world.servers = [server({ id: 'alpha', url: 'https://new.example/mcp' })];
    await ensureRemoteMcp(place, { retry: true });

    /* The old discovery answers late; it must not replace the new server's tools. */
    gate.open?.();
    await superseded;

    expect(remoteServerToolNames()).toEqual(['mcp_alpha_write']);
  });

  it('drops a disabled server’s cached tools when the list changes', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    await ensureRemoteMcp(place);
    expect(remoteServerTools()).toHaveLength(1);

    const disabled = server({ id: 'alpha', enabled: false });
    world.servers = [disabled];
    emitServers();

    expect(remoteServerTools()).toEqual([]);
    expect(remoteMcpState()).toEqual([
      stateOf(disabled, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
  });

  it('publishes a call that could not reach the server as that server’s failure', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    await ensureRemoteMcp(place);

    const fail = world.calls.at(-1)?.deps.onCallFailure;
    expect(fail).toBeDefined();
    fail?.(new RemoteMcpError({ serverId: 'alpha', kind: 'unreachable', cause: 'gone' }));

    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'failed', toolCount: 0, retryable: true }),
    ]);
    expect(remoteServerTools()).toEqual([]);
  });

  it('asks a failed server again rather than serving the failure', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    await ensureRemoteMcp(place);
    world.calls
      .at(-1)
      ?.deps.onCallFailure?.(
        new RemoteMcpError({ serverId: 'alpha', kind: 'unreachable', cause: 'gone' })
      );
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'failed', toolCount: 0, retryable: true }),
    ]);

    await ensureRemoteMcp(place, { retry: true });

    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
    ]);
    expect(world.calls).toHaveLength(2);
  });

  it('asks a server that answered with no tools again, never serving the empty list', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    answer = () => Effect.succeed([]);

    await ensureRemoteMcp(place);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 0, retryable: true }),
    ]);

    // An empty catalog is not an answer: the next ask reconnects, and a server
    // that has tools by then offers them.
    answer = () => Effect.succeed([tool('mcp_alpha_read')]);
    await ensureRemoteMcp(place);

    expect(world.calls).toHaveLength(2);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
    ]);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read']);
  });

  it('waits for the stored list after a cold start rather than discovering an empty one', async () => {
    const alpha = server({ id: 'alpha' });
    world.loaded = false;

    const running = ensureRemoteMcp(place);
    await Promise.resolve();
    world.servers = [alpha];
    world.loaded = true;
    world.load?.();
    await running;

    expect(world.calls).toHaveLength(1);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read']);
  });

  it('connects to nothing on an automatic ask made while confirmed offline, and offers a Retry', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    world.connectivity = 'offline';

    await ensureRemoteMcp(place);

    expect(world.calls).toHaveLength(0);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'failed', toolCount: 0, retryable: true }),
    ]);

    await ensureRemoteMcp(place, { retry: true });

    expect(world.calls).toHaveLength(1);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read']);
  });

  it('still connects while connectivity is unknown, as at boot', async () => {
    world.servers = [server({ id: 'alpha' })];
    world.connectivity = 'unknown';

    await ensureRemoteMcp(place);

    expect(world.calls).toHaveLength(1);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read']);
  });

  it('forgetRemoteMcp empties the state', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    await ensureRemoteMcp(place);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
    ]);

    forgetRemoteMcp();

    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
    expect(remoteServerTools()).toEqual([]);
    expect(remoteServerToolNames()).toEqual([]);
  });
});
