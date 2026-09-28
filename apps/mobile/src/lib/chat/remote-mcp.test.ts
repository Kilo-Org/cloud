import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { type RemoteMcpDiscovery } from './remote-mcp';
import { place, server, stateOf, tool } from './remote-mcp.test-helpers';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The stored remote MCP servers, discovered for the tools they offer.
 *
 * The pure helpers are the join between the list and the discovery, so they are
 * proven directly: an enabled server merges its tools, a disabled one does not,
 * and a failed discovery offers nothing. The store is faked so the module's own
 * subscription — the thing that drops a disabled server's tools — can be driven
 * without a device.
 */

const world = vi.hoisted(() => ({
  servers: [] as StoredRemoteMcpServer[],
  epoch: 0,
  calls: [] as {
    readonly server: RemoteMcpServer;
    readonly deps: RemoteMcpClientDeps;
  }[],
  listeners: [] as (() => void)[],
}));

vi.mock('./remote-mcp-store', () => ({
  listRemoteMcpServers: () => world.servers,
  subscribeRemoteMcpServers: (listener: () => void) => {
    world.listeners.push(listener);
    return () => {
      world.listeners = world.listeners.filter(current => current !== listener);
    };
  },
}));

vi.mock('@/lib/auth/auth-epoch', () => ({ currentAuthEpoch: () => world.epoch }));

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
  remoteServerStates,
  remoteServerToolNames,
  remoteServerTools,
  remoteServerToolsFor,
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
  answer = () => Effect.succeed([tool('mcp_alpha_read')]);
  forgetRemoteMcp();
});

describe('the pure helpers', () => {
  it('merges an enabled server’s tools, named for the server', () => {
    const alpha = server({ id: 'alpha' });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', { tools: [tool('mcp_alpha_read'), tool('mcp_alpha_write')] }],
    ]);

    expect(remoteServerToolsFor([alpha], discovered).map(entry => entry.definition.name)).toEqual([
      'mcp_alpha_read',
      'mcp_alpha_write',
    ]);
    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 2, retryable: false }),
    ]);
  });

  it('contributes nothing from a disabled server, whatever was cached', () => {
    const alpha = server({ id: 'alpha', enabled: false });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', { tools: [tool('mcp_alpha_read')] }],
    ]);

    expect(remoteServerToolsFor([alpha], discovered)).toEqual([]);
    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
  });

  it('keeps two servers’ tools distinct', () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', { tools: [tool('mcp_alpha_read')] }],
      ['beta', { tools: [tool('mcp_beta_read')] }],
    ]);

    expect(
      remoteServerToolsFor([alpha, beta], discovered).map(entry => entry.definition.name)
    ).toEqual(['mcp_alpha_read', 'mcp_beta_read']);
  });

  it('leaves a failed discovery failed and offers none of its tools', () => {
    const alpha = server({ id: 'alpha' });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', { tools: [tool('mcp_alpha_read')], failed: true }],
    ]);

    expect(remoteServerToolsFor([alpha], discovered)).toEqual([]);
    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'failed', toolCount: 0, retryable: true }),
    ]);
  });

  it('leaves a server that was never asked idle', () => {
    const alpha = server({ id: 'alpha' });

    expect(remoteServerStates([alpha], new Map())).toEqual([
      stateOf(alpha, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
  });
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
      stateOf(alpha, { status: 'ready', toolCount: 0, retryable: false }),
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
