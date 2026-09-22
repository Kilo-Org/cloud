import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeployedScenarioEnvironment } from '../../e2e/capabilities-deployed.js';

const SECRET = 'e2e-internal-secret-0123456789';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createDeployedScenarioEnvironment', () => {
  it('keeps the deployed auth boundary and control-plane requirement without a surface URL', () => {
    const env = createDeployedScenarioEnvironment({ internalApiSecret: SECRET });
    expect(env.profile).toBe('deployed');
    expect(env.requireControlPlaneSession).toBe(true);
    expect(env.deployedHttpAuthBoundary).toEqual({ modelRoutesAuthenticated: true });
    expect(env.sessionSandbox).toBeUndefined();
    expect(env.callbacks).toBeUndefined();
  });

  it('treats an empty or whitespace surfaceUrl as absent', () => {
    const env = createDeployedScenarioEnvironment({
      surfaceUrl: '   ',
      internalApiSecret: SECRET,
    });
    expect(env.sessionSandbox).toBeUndefined();
    expect(env.callbacks).toBeUndefined();
  });

  it('omits the HTTP capabilities without an e2e internal secret', () => {
    for (const internalApiSecret of [undefined, '', '   ']) {
      const env = createDeployedScenarioEnvironment({
        surfaceUrl: 'https://worker.test',
        internalApiSecret,
      });
      expect(env.sessionSandbox).toBeUndefined();
      expect(env.callbacks).toBeUndefined();
    }
  });

  it('adds the HTTP sessionSandbox and callbacks only when surfaceUrl and a secret are present', () => {
    const env = createDeployedScenarioEnvironment({
      surfaceUrl: 'https://worker.test',
      internalApiSecret: SECRET,
    });
    expect(env.sessionSandbox).toBeDefined();
    expect(env.callbacks).toBeDefined();
  });

  it('mints, reads and releases a callback token through the surface with the internal key', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://worker.test/__e2e/callbacks' && init?.method === 'POST') {
        return Response.json({
          token: 'token-9',
          callbackUrl: 'https://worker.test/__e2e/callbacks/token-9',
        });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ records: [{ cloudAgentSessionId: 'agent_1', status: 'completed' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const env = createDeployedScenarioEnvironment({
      surfaceUrl: 'https://worker.test/',
      bearerToken: 'token-1',
      internalApiSecret: SECRET,
    });
    const sink = await env.callbacks?.open();
    expect(sink?.callbackUrl).toBe('https://worker.test/__e2e/callbacks/token-9');

    const payload = await sink?.waitFor(candidate => candidate.status === 'completed', 1_000);
    expect(payload?.cloudAgentSessionId).toBe('agent_1');

    await sink?.close();
    const readCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === 'https://worker.test/__e2e/callbacks/token-9' &&
        (init as RequestInit | undefined)?.method !== 'DELETE'
    );
    const readInit = readCall === undefined ? undefined : (readCall[1] as RequestInit);
    expect(readInit?.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'x-internal-api-key': SECRET,
    });
  });

  it('reads physical provider refs from the surface allocation route with the internal key', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      Response.json({
        logicalSandboxId: 'usr-123456789abc',
        physicalProviderRef: 'provider-ref-9',
        physicalState: 'running',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createDeployedScenarioEnvironment({
      surfaceUrl: 'https://worker.test/',
      bearerToken: 'token-1',
      internalApiSecret: SECRET,
    });
    const container = await env.sessionSandbox?.currentContainer({
      cloudAgentSessionId: 'agent_1',
      kiloSessionId: 'ses_1',
    });

    expect(container).toBe('provider-ref-9');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://worker.test/__e2e/inspect/allocation/agent_1');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'x-internal-api-key': SECRET,
    });
  });

  it('polls the allocation route until a provider ref appears (transient miss tolerated)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return Response.json({
        logicalSandboxId: 'usr-123456789abc',
        physicalProviderRef: calls === 1 ? null : 'provider-ref-9',
        physicalState: calls === 1 ? 'creating' : 'running',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const env = createDeployedScenarioEnvironment({
      surfaceUrl: 'https://worker.test/',
      bearerToken: 'token-1',
      internalApiSecret: SECRET,
    });
    const pending = env.sessionSandbox!.waitForContainer({
      cloudAgentSessionId: 'agent_1',
      kiloSessionId: 'ses_1',
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(600);

    await expect(pending).resolves.toBe('provider-ref-9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
