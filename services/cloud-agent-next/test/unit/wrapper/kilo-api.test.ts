import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import type { KiloClient as SDKClient } from '@kilocode/sdk';

function createSdkClient(): SDKClient {
  return {
    session: {},
  } as SDKClient;
}

describe('createWrapperKiloClient network endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty list when the SDK network list response contains an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'server rejected list' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0');

    await expect(client.getNetworkWaits()).resolves.toEqual([]);
  });

  it('throws when the SDK network reply response contains an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'missing network wait' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0');

    await expect(client.resumeNetworkWait('net_req_missing')).rejects.toThrow(
      'Network reply net_req_missing failed: missing network wait'
    );
  });
});
