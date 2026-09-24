import { Sandbox } from 'e2b';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiKey = 'test-e2b-customer-key';
const connection = {
  apiKey,
  apiUrl: 'https://api.e2b.app',
  domain: 'e2b.app',
  sandboxUrl: 'https://sandbox.e2b.app',
  debug: false,
  requestTimeoutMs: 1_000,
};
const template = 'kilo-test/control-wrapper:11111111-1111-4111-8111-111111111111';
const sandboxID = 'e2b-sdk-transport-test';
const metadata = { operationId: 'test-operation', runtimeBuildId: 'test-runtime' };

function sandboxInfo(state: 'running' | 'paused' = 'running') {
  return {
    sandboxID,
    templateID: 'template-id',
    clientID: 'test-client',
    metadata,
    startedAt: '2026-09-03T00:00:00.000Z',
    endAt: '2026-09-03T00:05:00.000Z',
    state,
    envdVersion: '0.5.7',
    cpuCount: 2,
    memoryMB: 4096,
    diskSizeMB: 10240,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('pinned E2B SDK transport in Workers', () => {
  it('loads in workerd and submits one explicit finite, secured create request', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        return Response.json(
          {
            ...sandboxInfo(),
            envdAccessToken: 'test-envd-token',
            trafficAccessToken: 'test-traffic-token',
          },
          { status: 201 }
        );
      })
    );
    const sandbox = await Sandbox.create(template, {
      ...connection,
      timeoutMs: 300_000,
      lifecycle: { onTimeout: 'kill', autoResume: false },
      secure: true,
      allowInternetAccess: true,
      network: { allowPublicTraffic: false },
      metadata,
    });
    expect(sandbox.sandboxId).toBe(sandboxID);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe('https://api.e2b.app/sandboxes');
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('X-API-Key')).toBe(apiKey);
    const body = await request?.text();
    expect(JSON.parse(body ?? '')).toMatchObject({
      templateID: template,
      timeout: 300,
      autoPause: false,
      autoResume: { enabled: false },
      secure: true,
      allow_internet_access: true,
      network: { allowPublicTraffic: false },
      metadata,
    });
    expect(body).not.toContain(apiKey);
  });

  it('does not retry a create POST whose response is lost', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      await request.text();
      throw new TypeError('Simulated lost create response');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      Sandbox.create(template, {
        ...connection,
        timeoutMs: 300_000,
        lifecycle: { onTimeout: 'kill', autoResume: false },
        network: { allowPublicTraffic: false },
      })
    ).rejects.toThrow('Simulated lost create response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('consumes paginated running and paused metadata without resuming', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        return requests.length === 1
          ? Response.json([sandboxInfo()], { headers: { 'X-Next-Token': 'second-page' } })
          : Response.json([{ ...sandboxInfo('paused'), sandboxID: 'second-sandbox' }]);
      })
    );
    const paginator = Sandbox.list({
      ...connection,
      query: { metadata, state: ['running', 'paused'] },
      limit: 10,
    });
    expect(requests).toHaveLength(0);
    expect(await paginator.nextItems(connection)).toHaveLength(1);
    expect(paginator.hasNext).toBe(true);
    expect(await paginator.nextItems(connection)).toHaveLength(1);
    expect(paginator.hasNext).toBe(false);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.origin).toBe('https://api.e2b.app');
      expect(url.pathname).toBe('/v2/sandboxes');
      expect(url.searchParams.get('state')).toBe('running,paused');
      expect(request.headers.get('X-API-Key')).toBe(apiKey);
    }
    expect(new URL(requests[1]?.url ?? '').searchParams.get('nextToken')).toBe('second-page');
  });

  it('uses management reads for paused observation, then exact timeout and kill requests', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        return request.method === 'GET'
          ? Response.json(sandboxInfo('paused'))
          : new Response(null, { status: 204 });
      })
    );
    await expect(Sandbox.getInfo(sandboxID, connection)).resolves.toMatchObject({
      sandboxId: sandboxID,
      state: 'paused',
    });
    await Sandbox.setTimeout(sandboxID, 120_000, connection);
    await expect(Sandbox.kill(sandboxID, connection)).resolves.toBe(true);
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', `/sandboxes/${sandboxID}`],
      ['POST', `/sandboxes/${sandboxID}/timeout`],
      ['DELETE', `/sandboxes/${sandboxID}`],
    ]);
    expect(requests.every(request => request.headers.get('X-API-Key') === apiKey)).toBe(true);
    expect(await requests[1]?.json()).toEqual({ timeout: 120 });
  });
});
