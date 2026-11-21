import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import { mcpCallResultOf } from './remote-mcp-call-results';
import { place, server, tool } from './remote-mcp.test-helpers';
import {
  discovery,
  emitServers,
  ensureRemoteMcp,
  flush,
  forgetRemoteMcp,
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
