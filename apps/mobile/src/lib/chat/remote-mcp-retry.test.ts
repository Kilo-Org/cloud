import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import { RemoteMcpError } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { place, server, tool } from './remote-mcp.test-helpers';
import {
  discovery,
  ensureRemoteMcp,
  flush,
  resetWorld,
  whenReleased,
  world,
} from './remote-mcp.world.test-helpers';

/**
 * A Retry tapped while a pass is running waits for that pass. Admission is what
 * decides the next discovery, so it is checked after that wait as well: two
 * retries waiting on one pass must still start one discovery between them.
 */

beforeEach(() => {
  resetWorld();
});

describe('admitting a Retry after it waited on a running pass', () => {
  it('starts one discovery for two Retries waiting on the same pass', async () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    const gamma = server({ id: 'gamma' });
    world.servers = [alpha, beta, gamma];
    const gammaGate = Promise.withResolvers<undefined>();
    const retryGate = Promise.withResolvers<undefined>();
    discovery.answer = target => {
      if (target.id === 'gamma') {
        return whenReleased(gammaGate.promise, [tool('mcp_gamma_read')]);
      }
      /* The two rows the person sees failed, retried: those answers are held
         open, so a second pass started alongside the first shows up as two
         more calls before anything is released. */
      const failedRows = world.calls.filter(call => call.server.id !== 'gamma');
      if (failedRows.length <= 2) {
        return Effect.fail(
          new RemoteMcpError({ serverId: target.id, kind: 'unreachable', cause: 'gone' })
        );
      }
      return whenReleased(retryGate.promise, [tool(`mcp_${target.id}_read`)]);
    };

    /* Alpha and beta fail at once; gamma is why the automatic pass is still out. */
    const automatic = ensureRemoteMcp(place);
    const firstRetry = ensureRemoteMcp(place, { retry: true });
    const secondRetry = ensureRemoteMcp(place, { retry: true });
    gammaGate.resolve(undefined);
    await flush();

    expect(world.calls.filter(call => call.server.id !== 'gamma')).toHaveLength(4);

    retryGate.resolve(undefined);
    await Promise.all([automatic, firstRetry, secondRetry]);
  });
});
