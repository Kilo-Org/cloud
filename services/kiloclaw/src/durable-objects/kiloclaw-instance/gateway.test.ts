import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveGatewayToken } from '../../auth/gateway-token';
import { createMutableState } from './state';
import { getGatewayProcessStatus, getMorningBriefingStatus, waitForHealthy } from './gateway';
import { GatewayControllerError } from '../gateway-controller-types';

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
>;

function getFetchCall(
  fetchMock: FetchMock,
  index = 0
): { input: unknown; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call at index ${index}`);
  }

  const input = call[0];
  const rawInit = call[1];
  const init = rawInit && typeof rawInit === 'object' ? rawInit : undefined;
  return { input, init };
}

describe('gateway controller routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes controller RPCs through provider transport headers', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'running',
          pid: 123,
          uptime: 5,
          restarts: 0,
          lastExit: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getGatewayProcessStatus(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    const expectedToken = await deriveGatewayToken('sandbox-1', 'gateway-secret');

    expect(result.state).toBe('running');
    const { input, init } = getFetchCall(fetchMock);
    expect(input).toBe('https://test-app.fly.dev/_kilo/gateway/status');
    expect(init).toBeDefined();
    expect(init?.method).toBe('GET');

    const headers = init?.headers;
    expect(headers).toBeDefined();
    expect(headers).toMatchObject({
      Authorization: `Bearer ${expectedToken}`,
      Accept: 'application/json',
      'fly-force-instance-id': 'machine-1',
    });
  });

  it('uses provider routing for health probes', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'running' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await waitForHealthy(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    const expectedToken = await deriveGatewayToken('sandbox-1', 'gateway-secret');

    const { input: statusUrl, init: statusInit } = getFetchCall(fetchMock, 0);
    expect(statusUrl).toBe('https://test-app.fly.dev/_kilo/gateway/status');
    expect(statusInit?.headers).toMatchObject({
      Authorization: `Bearer ${expectedToken}`,
      Accept: 'application/json',
      'fly-force-instance-id': 'machine-1',
    });

    const { input: rootUrl, init: rootInit } = getFetchCall(fetchMock, 1);
    expect(rootUrl).toBe('https://test-app.fly.dev/');
    expect(rootInit?.headers).toMatchObject({
      'fly-force-instance-id': 'machine-1',
    });
  });

  it('returns warm-up payload for morning-briefing status when gateway is warming up', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Gateway not running' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getMorningBriefingStatus(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    expect(result).toEqual({
      ok: true,
      enabled: false,
      reconcileState: 'in_progress',
      error: 'Gateway warming up, retrying shortly.',
      code: 'gateway_warming_up',
      retryAfterSec: 2,
    });
  });

  it('does not mask 401 auth failures as warm-up for morning-briefing status', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getMorningBriefingStatus(state, {
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_APP_NAME: 'fallback-app',
      } as never)
    ).rejects.toBeInstanceOf(GatewayControllerError);
  });
});
