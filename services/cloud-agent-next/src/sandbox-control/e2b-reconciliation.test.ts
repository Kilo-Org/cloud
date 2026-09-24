import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileE2BCreate } from './e2b-reconciliation.js';
import { e2bCreateMetadata, E2B_RECONCILIATION_WINDOW_MS } from './e2b-runtime.js';
import {
  e2bTestConfig,
  e2bTestSandbox,
  E2B_TEST_INTENT_ID,
  E2B_TEST_KEY,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
} from './e2b-test-fixtures.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(E2B_TEST_NOW);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected test HTTP request')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E2B complete-or-unknown reconciliation', () => {
  it('finishes every page before returning the single owned candidate', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        return requests.length === 1
          ? Response.json([e2bTestSandbox(e2bTestConfig())], { headers: { 'X-Next-Token': 'next-page' } })
          : Response.json([]);
      })
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toMatchObject({
      sandboxID: E2B_TEST_PHYSICAL_ID,
    });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1].url).searchParams.get('nextToken')).toBe('next-page');
    expect(
      requests.every(
        request => request.method === 'GET' && request.headers.get('X-API-Key') === E2B_TEST_KEY
      )
    ).toBe(true);
  });

  it('can discover a candidate on the second complete pass', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(++calls === 1 ? [] : [e2bTestSandbox(e2bTestConfig())]))
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toMatchObject({
      sandboxID: E2B_TEST_PHYSICAL_ID,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after two empty passes without proving absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([]))
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not pick one of multiple owned physical IDs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          e2bTestSandbox(e2bTestConfig()),
          { ...e2bTestSandbox(e2bTestConfig()), sandboxID: 'second-owned-sandbox', state: 'paused' },
        ])
      )
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not publish a partial reference when a later page fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ++calls === 1
          ? Response.json([e2bTestSandbox(e2bTestConfig())], { headers: { 'X-Next-Token': 'second' } })
          : new Response(E2B_TEST_KEY, { status: 401 })
      )
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops at five pages and one hundred results without exposing a partial candidate', async () => {
    let pages = 0;
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json(
          Array.from({ length: 20 }, () => e2bTestSandbox(e2bTestConfig())),
          { headers: { 'X-Next-Token': `page-${++pages}` } }
        );
      })
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(requests).toHaveLength(5);
    expect(requests.every(request => new URL(request.url).searchParams.get('limit') === '20')).toBe(
      true
    );
  });

  it('treats a looping continuation token as incomplete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([e2bTestSandbox(e2bTestConfig())], { headers: { 'X-Next-Token': 'same-token' } })
      )
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('discards a candidate when scanning consumes the ten-second time budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + 10_000);
        return Response.json([e2bTestSandbox(e2bTestConfig())]);
      })
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not start another scan episode after the saved reconciliation deadline', async () => {
    vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_RECONCILIATION_WINDOW_MS);
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not scan an operation that was never submitted', async () => {
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(false), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(Object.keys(e2bCreateMetadata(e2bTestConfig(), E2B_TEST_INTENT_ID)))(
    'rejects a candidate with mismatched %s metadata',
    async key => {
      const info = e2bTestSandbox(e2bTestConfig());
      info.metadata[key] = 'other-value';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json([info]))
      );
      await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
    }
  );

  it.each([
    { templateID: 'different-template' },
    { cpuCount: 4 },
    { memoryMB: 8192 },
    { sandboxID: '../not-a-physical-id' },
    { state: 'terminated' },
  ])('rejects an invalid source, physical ID, or resource profile %#', async patch => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([{ ...e2bTestSandbox(e2bTestConfig()), ...patch }]))
    );
    await expect(reconcileE2BCreate(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID)).resolves.toBeNull();
  });
});
