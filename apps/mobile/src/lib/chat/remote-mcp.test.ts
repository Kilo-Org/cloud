import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import { RemoteMcpError } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { place, server, stateOf, tool } from './remote-mcp.test-helpers';
import {
  discovery,
  emitServers,
  ensureRemoteMcp,
  forgetRemoteMcp,
  oauthProvider,
  remoteMcpState,
  remoteServerToolNames,
  remoteServerTools,
  resetWorld,
  whenReleased,
  world,
} from './remote-mcp.world.test-helpers';

/**
 * The stored remote MCP servers, discovered for the tools they offer.
 *
 * The store is faked, in `remote-mcp.world.test-helpers`, so the module's own
 * subscription — the thing that drops a disabled server's tools — can be driven
 * without a device.
 */

beforeEach(() => {
  resetWorld();
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

  it('asks a person’s Retry again after an automatic pass settles', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    world.servers = [alpha, beta];
    const gate: { open?: () => void } = {};
    const held = new Promise<void>(resolve => {
      gate.open = resolve;
    });
    let call = 0;
    discovery.answer = () => {
      call += 1;
      if (call === 1) {
        return Effect.fail(
          new RemoteMcpError({ serverId: 'alpha', kind: 'unreachable', cause: 'gone' })
        );
      }
      if (call === 2) {
        return whenReleased(held, [tool('mcp_beta_read')]);
      }
      return Effect.succeed([tool('mcp_alpha_read')]);
    };

    const automatic = ensureRemoteMcp(place);
    // The retry is tapped while the automatic pass is still running: alpha has
    // already failed and beta is the reason the pass has not settled.
    const retry = ensureRemoteMcp(place, { retry: true });
    gate.open?.();
    await Promise.all([automatic, retry]);

    const alphaCalls = world.calls.filter(entry => entry.server.id === 'alpha');
    expect(alphaCalls).toHaveLength(2);
    // The retry asked with its own deadline, not the automatic pass's.
    expect(alphaCalls[1]?.deps.discoverTimeoutMs).toBe(15_000);
  });

  it('asks again even when the running pass was itself a retry', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    world.servers = [alpha, beta];
    const gate: { open?: () => void } = {};
    const held = new Promise<void>(resolve => {
      gate.open = resolve;
    });
    let call = 0;
    discovery.answer = () => {
      call += 1;
      if (call === 1) {
        return Effect.fail(
          new RemoteMcpError({ serverId: 'alpha', kind: 'unreachable', cause: 'gone' })
        );
      }
      if (call === 2) {
        return whenReleased(held, [tool('mcp_beta_read')]);
      }
      return Effect.succeed([tool('mcp_alpha_read')]);
    };

    const first = ensureRemoteMcp(place, { retry: true });
    const second = ensureRemoteMcp(place, { retry: true });
    gate.open?.();
    await Promise.all([first, second]);

    expect(world.calls.filter(entry => entry.server.id === 'alpha')).toHaveLength(2);
  });

  it('joins one pass for an automatic ask', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    const gate: { open?: () => void } = {};
    const held = new Promise<void>(resolve => {
      gate.open = resolve;
    });
    discovery.answer = () => whenReleased(held, [tool('mcp_alpha_read')]);

    const first = ensureRemoteMcp(place);
    const second = ensureRemoteMcp(place);
    gate.open?.();
    await Promise.all([first, second]);

    expect(world.calls).toHaveLength(1);
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

  it('asks the person to sign in when an OAuth server refuses, and offers no Retry', async () => {
    const oauth = server({ id: 'gamma', auth: { type: 'oauth' } });
    world.servers = [oauth];
    discovery.answer = () =>
      Effect.fail(
        new RemoteMcpError({ serverId: 'gamma', kind: 'unauthorized', cause: 'sign in' })
      );

    await ensureRemoteMcp(place);

    expect(world.calls[0]?.deps.authProvider).toBe(oauthProvider);
    expect(world.calls[0]?.deps.token).toBeUndefined();
    expect(remoteMcpState()).toEqual([
      stateOf(oauth, { status: 'signIn', toolCount: 0, retryable: false }),
    ]);
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
    discovery.answer = () => {
      call += 1;
      if (call > 1) {
        return Effect.succeed([tool('mcp_alpha_write')]);
      }
      return whenReleased(held, [tool('mcp_alpha_read')]);
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
    discovery.answer = () => Effect.succeed([]);

    await ensureRemoteMcp(place);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 0, retryable: true }),
    ]);

    // An empty catalog is not an answer: the next ask reconnects, and a server
    // that has tools by then offers them.
    discovery.answer = () => Effect.succeed([tool('mcp_alpha_read')]);
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
