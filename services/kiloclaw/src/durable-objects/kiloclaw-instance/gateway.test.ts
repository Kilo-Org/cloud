import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveGatewayToken } from '../../auth/gateway-token';
import { createMutableState } from './state';
import { getGatewayProcessStatus, waitForHealthy } from './gateway';

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

    const fetchMock = vi.fn().mockResolvedValue(
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
    const [targetUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(targetUrl).toBe('https://test-app.fly.dev/_kilo/gateway/status');
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

    const fetchMock = vi
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

    const [statusUrl, statusInit] = fetchMock.mock.calls[0] ?? [];
    expect(statusUrl).toBe('https://test-app.fly.dev/_kilo/gateway/status');
    expect(statusInit?.headers).toMatchObject({
      Authorization: `Bearer ${expectedToken}`,
      Accept: 'application/json',
      'fly-force-instance-id': 'machine-1',
    });

    const [rootUrl, rootInit] = fetchMock.mock.calls[1] ?? [];
    expect(rootUrl).toBe('https://test-app.fly.dev/');
    expect(rootInit?.headers).toMatchObject({
      'fly-force-instance-id': 'machine-1',
    });
  });
});
