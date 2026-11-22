import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import { mcpCallResultOf } from './remote-mcp-call-results';
import { place, server, stateOf, tool } from './remote-mcp.test-helpers';
import {
  discovery,
  emitServers,
  ensureRemoteMcp,
  flush,
  forgetRemoteMcp,
  remoteMcpState,
  remoteServerToolNames,
  resetWorld,
  whenReleased,
  world,
} from './remote-mcp.world.test-helpers';

/**
 * What a change to one stored server costs the others.
 *
 * A server's answer belongs to that server's own config, so an add, an edit, a
 * toggle or a delete must reach only its server: the other servers keep the
 * tools, the views and the call answers they already earned, and a discovery
 * still in flight for one of them still publishes. The store is faked in
 * `remote-mcp.world.test-helpers`, so `emitServers` is the app's own change
 * notification.
 */

beforeEach(() => {
  resetWorld();
});

/** The same person in another place, which is the reset a returning scope follows. */
const teamPlace = { chatScope: 'org-1:team', org: { kind: 'organization' as const, id: 'org-1' } };

describe('a change to one server', () => {
  it('keeps the other server connected when one is toggled off and on', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    world.servers = [alpha, beta];
    discovery.answer = target => Effect.succeed([tool(`mcp_${target.id}_read`)]);
    await ensureRemoteMcp(place);

    /* The app asks again while beta is off — a chat opening beside the sheet
       does — and once more after the person turns it back on. */
    world.servers = [alpha, { ...beta, enabled: false }];
    emitServers();
    await ensureRemoteMcp(place);
    world.servers = [alpha, beta];
    emitServers();
    await ensureRemoteMcp(place, { retry: true });

    expect(world.calls.filter(call => call.server.id === 'alpha')).toHaveLength(1);
    expect(world.calls.filter(call => call.server.id === 'beta')).toHaveLength(2);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read', 'mcp_beta_read']);
  });

  it('discovers only the server whose endpoint changed', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    world.servers = [alpha, beta];
    discovery.answer = target => Effect.succeed([tool(`mcp_${target.id}_read`)]);
    await ensureRemoteMcp(place);

    world.servers = [alpha, { ...beta, url: 'https://moved.example/mcp' }];
    emitServers();
    await ensureRemoteMcp(place, { retry: true });

    expect(world.calls.filter(call => call.server.id === 'alpha')).toHaveLength(1);
    expect(world.calls.filter(call => call.server.id === 'beta')).toHaveLength(2);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read', 'mcp_beta_read']);
  });

  it('publishes a discovery that was in flight when another server changed', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    world.servers = [alpha, beta];
    const gate = Promise.withResolvers<undefined>();
    let alphaCalls = 0;
    discovery.answer = target => {
      if (target.id !== 'alpha') {
        return Effect.succeed([tool('mcp_beta_read')]);
      }
      alphaCalls += 1;
      return alphaCalls === 1
        ? whenReleased(gate.promise, [tool('mcp_alpha_read')])
        : Effect.succeed([tool('mcp_alpha_read')]);
    };

    const first = ensureRemoteMcp(place);
    await flush();

    world.servers = [alpha, { ...beta, url: 'https://moved.example/mcp' }];
    emitServers();
    await ensureRemoteMcp(place, { retry: true });

    gate.resolve(undefined);
    await first;

    expect(world.calls.filter(call => call.server.id === 'alpha')).toHaveLength(1);
    expect(world.calls.filter(call => call.server.id === 'beta')).toHaveLength(2);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read', 'mcp_beta_read']);
  });

  it('drops a deleted server’s tools while the servers that stayed keep theirs', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    const gamma = server({ id: 'gamma' });
    world.servers = [alpha, beta, gamma];
    discovery.answer = target => Effect.succeed([tool(`mcp_${target.id}_read`)]);
    await ensureRemoteMcp(place);

    world.servers = [alpha, gamma];
    emitServers();

    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read', 'mcp_gamma_read']);
    expect(remoteMcpState().map(state => state.id)).toEqual(['alpha', 'gamma']);

    const moved = { ...gamma, url: 'https://moved.example/mcp' };
    world.servers = [alpha, moved];
    emitServers();
    await ensureRemoteMcp(place, { retry: true });

    expect(world.calls.filter(call => call.server.id === 'alpha')).toHaveLength(1);
    expect(world.calls.filter(call => call.server.id === 'gamma')).toHaveLength(2);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read', 'mcp_gamma_read']);
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
      stateOf(moved, { status: 'ready', toolCount: 1, retryable: false }),
    ]);

    /* A server back under the deleted id is a server, not the answer the one
       before it earned: its row is idle until it has been asked again. */
    world.servers = [alpha, moved, beta];
    emitServers();
    expect(remoteMcpState()).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 1, retryable: false }),
      stateOf(moved, { status: 'ready', toolCount: 1, retryable: false }),
      stateOf(beta, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read', 'mcp_gamma_read']);

    await ensureRemoteMcp(place, { retry: true });

    expect(world.calls.filter(call => call.server.id === 'beta')).toHaveLength(2);
  });

  it('keeps the answer a transcript row draws when another server changes', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    world.servers = [alpha, beta];
    await ensureRemoteMcp(place);
    const answered = {
      tool: 'read',
      callId: 'call_1',
      content: [{ type: 'text' as const, text: 'chart drawn' }],
      structuredContent: { points: 3 },
    };

    world.calls[0]?.deps.onCallResult?.(answered);
    expect(mcpCallResultOf('call_1')).toEqual(answered);

    world.servers = [alpha, { ...beta, enabled: false }];
    emitServers();
    await ensureRemoteMcp(place, { retry: true });

    expect(mcpCallResultOf('call_1')).toEqual(answered);

    forgetRemoteMcp();
    expect(mcpCallResultOf('call_1')).toBeUndefined();
  });
});

describe('an account or place reset', () => {
  it('runs the returning scope’s pass rather than joining one the reset dropped', async () => {
    const alpha = server({ id: 'alpha' });
    world.servers = [alpha];
    const gate = Promise.withResolvers<undefined>();
    let calls = 0;
    discovery.answer = () => {
      calls += 1;
      return calls === 1
        ? whenReleased(gate.promise, [tool('mcp_alpha_read')])
        : Effect.succeed([tool('mcp_alpha_read')]);
    };

    const first = ensureRemoteMcp(place);
    await flush();

    /* The other place opens its chat while the app is offline, so it connects
       to nothing and the discovery above is the one still running. */
    world.connectivity = 'offline';
    await ensureRemoteMcp(teamPlace);
    world.connectivity = 'online';

    const returning = ensureRemoteMcp(place);
    await flush();

    gate.resolve(undefined);
    await Promise.all([first, returning]);

    expect(world.calls).toHaveLength(2);
    expect(remoteServerToolNames()).toEqual(['mcp_alpha_read']);
  });
});
