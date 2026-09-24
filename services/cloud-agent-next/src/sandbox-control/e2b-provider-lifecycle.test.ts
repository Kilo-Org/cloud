import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createE2BControlAdapter } from './e2b-provider.js';
import { E2B_MAX_LIFETIME_MS } from './e2b-runtime.js';
import {
  e2bTestSubmittedConfig,
  e2bTestRef,
  e2bTestSandbox,
  E2B_TEST_BINDING,
  E2B_TEST_INTENT_ID,
  E2B_TEST_KEY,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
  E2B_TEST_SANDBOX_ID,
} from './e2b-test-fixtures.js';

function adapter() {
  return createE2BControlAdapter({
    binding: E2B_TEST_BINDING,
    sandboxId: E2B_TEST_SANDBOX_ID,
    config: e2bTestSubmittedConfig(), intentId: E2B_TEST_INTENT_ID,
    resolveApiKey: async () => E2B_TEST_KEY,
  });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(E2B_TEST_NOW);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected test HTTP request')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E2B non-waking observation and exact cleanup', () => {
  it.each(['running', 'paused'] as const)(
    'returns an exact discovered reference for a %s resource',
    async state => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json([{ ...e2bTestSandbox(e2bTestSubmittedConfig()), state }]))
      );
      await expect(adapter().observe(null)).resolves.toEqual({
        status: state === 'running' ? 'active' : 'unknown',
        providerRef: e2bTestRef(),
      });
      const requests = vi.mocked(fetch).mock.calls.map(([request]) => request);
      expect(requests).toHaveLength(1);
      expect(
        requests.every(
          request =>
            request instanceof Request &&
            request.method === 'GET' &&
            new URL(request.url).pathname === '/v2/sandboxes'
        )
      ).toBe(true);
    }
  );

  it('never treats a paused resource or elapsed TTL as terminal', async () => {
    vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...e2bTestSandbox(e2bTestSubmittedConfig()), state: 'paused' }))
    );
    await expect(adapter().observe(e2bTestRef())).resolves.toEqual({ status: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('revalidates exact ownership then kills a paused resource after its lifetime and reconciliation deadlines', async () => {
    vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS + 1000);
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        return request.method === 'GET'
          ? Response.json({ ...e2bTestSandbox(e2bTestSubmittedConfig()), state: 'paused' })
          : new Response(null, { status: 204 });
      })
    );
    await expect(adapter().stop(e2bTestRef())).resolves.toBe('terminal');
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', `/sandboxes/${E2B_TEST_PHYSICAL_ID}`],
      ['DELETE', `/sandboxes/${E2B_TEST_PHYSICAL_ID}`],
    ]);
  });

  it('can stop a unique null-reference discovery without deleting arbitrary metadata matches', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const info = { ...e2bTestSandbox(e2bTestSubmittedConfig()), state: 'paused' };
        return Response.json(new URL(request.url).pathname === '/v2/sandboxes' ? [info] : info);
      })
    );
    await expect(adapter().stop(null)).resolves.toBe('terminal');
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET', 'DELETE']);
  });

  it('returns retryable for multiple candidates without killing either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([e2bTestSandbox(e2bTestSubmittedConfig()), { ...e2bTestSandbox(e2bTestSubmittedConfig()), sandboxID: 'another-id' }])
      )
    );
    await expect(adapter().stop(null)).resolves.toBe('retryable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sandboxID: 'someone-elses-sandbox' },
    { templateID: 'other-template' },
    { metadata: { ...e2bTestSandbox(e2bTestSubmittedConfig()).metadata, source: 'other-service' } },
    { metadata: { ...e2bTestSandbox(e2bTestSubmittedConfig()).metadata, operationId: 'other-operation' } },
    { metadata: { ...e2bTestSandbox(e2bTestSubmittedConfig()).metadata, credentialId: 'other-connection' } },
  ])('refuses exact cleanup when management ownership differs %#', async patch => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...e2bTestSandbox(e2bTestSubmittedConfig()), ...patch }))
    );
    await expect(adapter().stop(e2bTestRef())).resolves.toBe('retryable');
    await expect(adapter().observe(e2bTestRef())).resolves.toEqual({ status: 'unknown' });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([request]) => request instanceof Request && request.method === 'GET')
    ).toBe(true);
  });

  it.each([401, 403, 429, 500, 503])(
    'retains cleanup for read or kill HTTP %s instead of marking it terminal',
    async status => {
      for (const failureMethod of ['GET', 'DELETE']) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async (request: Request) =>
            request.method === failureMethod
              ? new Response(E2B_TEST_KEY, { status })
              : Response.json(e2bTestSandbox(e2bTestSubmittedConfig()))
          )
        );
        await expect(adapter().stop(e2bTestRef())).resolves.toBe('retryable');
      }
    }
  );

  it('accepts documented exact-ID 404 as terminal without a delete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    );
    await expect(adapter().observe(e2bTestRef())).resolves.toEqual({ status: 'terminal' });
    await expect(adapter().stop(e2bTestRef())).resolves.toBe('terminal');
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([request]) => request instanceof Request && request.method === 'GET')
    ).toBe(true);
  });
});

describe('E2B bounded replacement leases', () => {
  it('rounds up the requested floor with a margin and verifies the replacement TTL', async () => {
    const info = e2bTestSandbox(e2bTestSubmittedConfig());
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        if (request.method === 'POST') {
          const body = await request.json<{ timeout: number }>();
          info.endAt = new Date(E2B_TEST_NOW + body.timeout * 1000).toISOString();
          return new Response(null, { status: 204 });
        }
        return Response.json(info);
      })
    );
    await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 360_001)).resolves.toBeUndefined();
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(await requests[1].json()).toEqual({ timeout: 372 });
    expect(Date.parse(info.endAt)).toBeLessThanOrEqual(e2bTestSubmittedConfig().hardStopAt);
  });

  it('does not renew an already sufficient, bounded lease', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(e2bTestSandbox(e2bTestSubmittedConfig())))
    );
    await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 60_000)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('replaces rather than adds to an externally excessive TTL', async () => {
    const info = {
      ...e2bTestSandbox(e2bTestSubmittedConfig()),
      endAt: new Date(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS * 2).toISOString(),
    };
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        if (request.method === 'POST') {
          bodies.push(await request.json());
          info.endAt = new Date(E2B_TEST_NOW + 371_000).toISOString();
          return new Response(null, { status: 204 });
        }
        return Response.json(info);
      })
    );
    await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 360_000)).resolves.toBeUndefined();
    expect(bodies).toEqual([{ timeout: 371 }]);
  });

  it.each([360_000, 360_001, 380_000])(
    'refuses an unsatisfiable six-minute floor with %s ms of lifetime left',
    async remaining => {
      vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS - remaining);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(e2bTestSandbox(e2bTestSubmittedConfig())))
      );
      await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 360_000)).rejects.toMatchObject({
        code: 'byoc_e2b_lifetime_exceeded',
      });
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(([request]) => request instanceof Request && request.method === 'GET')
      ).toBe(true);
    }
  );

  it('rechecks the hard stop after management latency before renewing', async () => {
    vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS - 390_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS - 381_000);
        return Response.json(e2bTestSandbox(e2bTestSubmittedConfig()));
      })
    );
    await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 360_000)).rejects.toMatchObject({
      code: 'byoc_e2b_lifetime_exceeded',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['insufficient', 'beyond-cap'] as const)(
    'does not report success when the acknowledged timeout is %s',
    async outcome => {
      let updated = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (request: Request) => {
          if (request.method === 'POST') {
            updated = true;
            return new Response(null, { status: 204 });
          }
          const endAt =
            updated && outcome === 'beyond-cap'
              ? new Date(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS + 1).toISOString()
              : e2bTestSandbox(e2bTestSubmittedConfig()).endAt;
          return Response.json({ ...e2bTestSandbox(e2bTestSubmittedConfig()), endAt });
        })
      );
      await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 360_000)).rejects.toMatchObject({
        code: outcome === 'beyond-cap' ? 'byoc_e2b_lifetime_exceeded' : 'byoc_e2b_unavailable',
      });
    }
  );

  it.each([
    { state: 'paused' },
    { lifecycle: { onTimeout: 'pause', autoResume: false } },
    { lifecycle: { onTimeout: 'kill', autoResume: true } },
    { network: { allowPublicTraffic: true } },
  ])('does not extend a paused or policy-incompatible sandbox %#', async patch => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...e2bTestSandbox(e2bTestSubmittedConfig()), ...patch }))
    );
    await expect(adapter().ensureLeaseAtLeast(e2bTestRef(), 360_000)).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
