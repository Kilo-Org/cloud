import { Sandbox } from 'e2b';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import type { E2BSubmittedAllocationConfig } from '../sandbox-state/model/allocation.js';
import { createE2BControlAdapter } from './e2b-provider.js';
import { E2B_MAX_LIFETIME_MS, encodeE2BProviderRef } from './e2b-runtime.js';
import {
  e2bTestConfig,
  e2bTestPendingConfig,
  e2bTestRef,
  e2bTestSandbox,
  e2bTestSubmittedConfig,
  E2B_TEST_BINDING,
  E2B_TEST_INTENT_ID,
  E2B_TEST_KEY,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
  E2B_TEST_SANDBOX_ID,
} from './e2b-test-fixtures.js';

type AdapterConfig = Parameters<typeof createE2BControlAdapter>[0]['config'];

function intentFor(config: AdapterConfig) {
  return { intentId: E2B_TEST_INTENT_ID, createdAt: E2B_TEST_NOW, e2b: config };
}

function adapter(
  config: AdapterConfig,
  resolveApiKey = vi.fn(async () => E2B_TEST_KEY),
  submitCreateIntent?: () => Promise<E2BSubmittedAllocationConfig>
) {
  return createE2BControlAdapter({
    binding: E2B_TEST_BINDING,
    sandboxId: E2B_TEST_SANDBOX_ID,
    config,
    intentId: E2B_TEST_INTENT_ID,
    resolveApiKey,
    ...(submitCreateIntent ? { submitCreateIntent } : {}),
  });
}

/** A create-shaped adapter: pending target plus the submission callback the DO
 * dispatches before the POST. */
function submittingAdapter(
  resolveApiKey = vi.fn(async () => E2B_TEST_KEY),
  submitted: E2BSubmittedAllocationConfig = e2bTestSubmittedConfig()
) {
  const pending = e2bTestPendingConfig();
  const submit = vi.fn(async () => submitted);
  return { provider: adapter(pending, resolveApiKey, submit), pending, submitted, submit };
}

const forbiddenConnect = vi.fn(async () => {
  throw new Error('Sandbox.connect is forbidden');
});

beforeEach(() => {
  forbiddenConnect.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(E2B_TEST_NOW);
  vi.spyOn(Sandbox, 'connect').mockImplementation(forbiddenConnect);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected test HTTP request')));
});
afterEach(() => {
  expect(forbiddenConnect).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('E2B create ownership and uncertainty', () => {
  it('refuses to POST a pending block that has no submission callback', async () => {
    const pending = e2bTestPendingConfig();
    const resolve = vi.fn(async () => E2B_TEST_KEY);
    await expect(adapter(pending, resolve).create(intentFor(pending))).rejects.toMatchObject({
      code: 'byoc_e2b_policy_mismatch',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('commits the submission callback before POSTing and rejects a repeat on the same handle', async () => {
    const { provider, pending, submitted, submit } = submittingAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(e2bTestSandbox(submitted), { status: 201 }))
    );
    expect(provider.resumable).toBe(false);
    expect(provider.persistentWorkspace).toBe(false);
    expect(provider.destroysOnStop).toBe(true);
    await expect(provider.create(intentFor(pending))).resolves.toEqual({
      providerRef: e2bTestRef(),
    });
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(provider.create(intentFor(submitted))).rejects.toMatchObject({
      code: 'byoc_e2b_create_unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fences concurrent create calls before resolving credentials', async () => {
    let release: ((key: string) => void) | undefined;
    const resolve = vi.fn(
      () =>
        new Promise<string>(accept => {
          release = accept;
        })
    );
    const { provider, pending, submitted } = submittingAdapter(resolve);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(e2bTestSandbox(submitted), { status: 201 }))
    );
    const first = provider.create(intentFor(pending));
    await expect(provider.create(intentFor(pending))).rejects.toMatchObject({
      code: 'byoc_e2b_create_unknown',
    });
    release?.(E2B_TEST_KEY);
    await expect(first).resolves.toEqual({ providerRef: e2bTestRef() });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'paused'] as const)(
    'recovers one %s resource after response loss without another POST',
    async state => {
      const { provider, pending, submitted } = submittingAdapter();
      const info = { ...e2bTestSandbox(submitted), state };
      const requests: Request[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (request: Request) => {
          requests.push(request);
          if (request.method === 'POST') throw new TypeError(E2B_TEST_KEY);
          return Response.json(new URL(request.url).pathname === '/v2/sandboxes' ? [info] : info);
        })
      );
      await expect(provider.create(intentFor(pending))).resolves.toEqual({
        providerRef: e2bTestRef(),
      });
      expect(requests.map(request => request.method)).toEqual(['POST', 'GET']);
      if (state === 'paused') {
        await expect(provider.launch(e2bTestRef(), {})).rejects.toMatchObject({
          code: 'byoc_e2b_bootstrap_failed',
        });
        expect(
          requests.every(request => new URL(request.url).origin === 'https://api.e2b.app')
        ).toBe(true);
      }
    }
  );

  it.each(['zero', 'multiple', 'incomplete'] as const)(
    'retains %s reconciliation as unknown and never infers absence from TTL',
    async scenario => {
      const { provider, pending, submitted } = submittingAdapter();
      const first = e2bTestSandbox(submitted);
      let lists = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (request: Request) => {
          if (request.method === 'POST') throw new TypeError('Simulated lost response');
          lists++;
          if (scenario === 'zero') return Response.json([]);
          if (scenario === 'multiple')
            return Response.json([first, { ...first, sandboxID: 'another-owned-id' }]);
          if (lists === 1) return Response.json([first], { headers: { 'X-Next-Token': 'second' } });
          return new Response(null, { status: 503 });
        })
      );
      await expect(provider.create(intentFor(pending))).resolves.toEqual({ unresolved: true });
      const requestsBeforeExpiry = vi.mocked(fetch).mock.calls.length;
      vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + E2B_MAX_LIFETIME_MS * 2);
      await expect(provider.observe(null)).resolves.toEqual({ status: 'unknown' });
      await expect(provider.stop(null)).resolves.toBe('retryable');
      expect(fetch).toHaveBeenCalledTimes(requestsBeforeExpiry);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([request]) => request instanceof Request && request.method === 'POST')
      ).toHaveLength(1);
    }
  );

  it.each([
    [401, 'byoc_e2b_credential_invalid'],
    [403, 'byoc_e2b_credential_invalid'],
    [404, 'byoc_e2b_template_unavailable'],
    [429, 'byoc_e2b_capacity'],
  ])('reports create HTTP %s without leaking its response', async (status, code) => {
    const { provider, pending } = submittingAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(E2B_TEST_KEY, { status: Number(status) }))
    );
    const error = await provider.create(intentFor(pending)).catch(error => error);
    expect(error).toBeInstanceOf(E2BProviderError);
    expect(error.code).toBe(code);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(E2B_TEST_KEY);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects creation after a slow credential lookup consumes the saved deadline', async () => {
    const resolve = vi.fn(async () => {
      vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + 60_000);
      return E2B_TEST_KEY;
    });
    const { provider, pending } = submittingAdapter(
      resolve,
      e2bTestSubmittedConfig(E2B_TEST_NOW + 30_000)
    );
    await expect(provider.create(intentFor(pending))).rejects.toMatchObject({
      code: 'byoc_e2b_create_unknown',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not scan when a recovery credential lookup outlives the reconciliation deadline', async () => {
    const resolve = vi.fn(async () => {
      vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + 61_000);
      return E2B_TEST_KEY;
    });
    const provider = adapter(e2bTestSubmittedConfig(), resolve);
    // Recovery (a null reference) must settle without listing when the
    // credential arrives after the window, unlike a create lookup.
    await expect(provider.observe(null)).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(null)).resolves.toBe('retryable');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('E2B per-operation credentials and persisted pins', () => {
  it('resolves a fresh explicit key for each valid operation without a cached account fallback', async () => {
    let counter = 0;
    const resolve = vi.fn(async () => `test-only-key-${++counter}`);
    const { provider, pending, submitted } = submittingAdapter(resolve);
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json(e2bTestSandbox(submitted), {
          status: request.method === 'POST' ? 201 : 200,
        });
      })
    );
    await provider.create(intentFor(pending));
    await provider.ensureBillingAdmission(e2bTestRef());
    await provider.observe(e2bTestRef());
    await provider.ensureLeaseAtLeast(e2bTestRef(), 60_000);
    await provider.logs(e2bTestRef());
    await provider.stop(e2bTestRef());
    expect(resolve).toHaveBeenCalledTimes(6);
    for (let call = 1; call <= 6; call++)
      expect(resolve).toHaveBeenNthCalledWith(call, E2B_TEST_BINDING);
    expect(requests.map(request => request.headers.get('X-API-Key'))).toEqual([
      'test-only-key-1',
      'test-only-key-3',
      'test-only-key-4',
      'test-only-key-6',
      'test-only-key-6',
    ]);
  });

  it('does not retain caller-owned mutable binding or block objects', async () => {
    const config = e2bTestSubmittedConfig();
    const binding = { ...E2B_TEST_BINDING };
    const resolve = vi.fn(async () => E2B_TEST_KEY);
    const provider = createE2BControlAdapter({
      binding,
      sandboxId: E2B_TEST_SANDBOX_ID,
      config,
      intentId: E2B_TEST_INTENT_ID,
      resolveApiKey: resolve,
    });
    binding.credentialId = 'eeeeeeee-2222-4222-8222-222222222222';
    (config as { templateId: string }).templateId = 'otherrelease';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(e2bTestSandbox(e2bTestSubmittedConfig())))
    );
    await expect(provider.observe(e2bTestRef())).resolves.toEqual({ status: 'active' });
    expect(resolve).toHaveBeenCalledWith(E2B_TEST_BINDING);
    await expect(provider.create(intentFor(config))).rejects.toMatchObject({
      code: 'byoc_e2b_policy_mismatch',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not issue management calls when the bound connection is removed', async () => {
    const resolve = vi.fn(async () => {
      throw new E2BProviderError('byoc_e2b_credential_missing');
    });
    const { provider, pending } = submittingAdapter(resolve);
    await expect(provider.create(intentFor(pending))).rejects.toMatchObject({
      code: 'byoc_e2b_credential_missing',
    });
    await expect(provider.observe(e2bTestRef())).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(e2bTestRef())).resolves.toBe('retryable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('withholds all guest logs instead of leaking arbitrary guest secrets', async () => {
    const resolve = vi.fn(async () => E2B_TEST_KEY);
    const provider = adapter(e2bTestSubmittedConfig(), resolve);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('test-only-git-token test-only-kilo-token'))
    );
    const logs = await provider.logs(e2bTestRef());
    expect(logs).toBe('E2B guest logs are withheld because they may contain credentials.');
    expect(logs).not.toContain(E2B_TEST_KEY);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('validates the physical reference and full saved identity before any I/O', async () => {
    const resolve = vi.fn(async () => E2B_TEST_KEY);
    const provider = adapter(e2bTestSubmittedConfig(), resolve);
    const wrongRef = encodeE2BProviderRef({
      physicalId: E2B_TEST_PHYSICAL_ID,
      intentId: 'eeeeeeee-5555-4555-8555-555555555555',
    });
    await expect(provider.observe(wrongRef)).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(wrongRef)).resolves.toBe('retryable');
    await expect(provider.launch(wrongRef, {})).rejects.toMatchObject({
      code: 'byoc_e2b_policy_mismatch',
    });
    await expect(provider.ensureLeaseAtLeast(wrongRef, 60_000)).rejects.toMatchObject({
      code: 'byoc_e2b_policy_mismatch',
    });
    await expect(provider.logs(wrongRef)).rejects.toMatchObject({
      code: 'byoc_e2b_policy_mismatch',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      createE2BControlAdapter({
        binding: E2B_TEST_BINDING,
        sandboxId: 'wrong-sandbox',
        config: e2bTestConfig(),
        intentId: E2B_TEST_INTENT_ID,
        resolveApiKey: resolve,
      })
    ).toThrow(new E2BProviderError('byoc_e2b_policy_mismatch'));
  });

  it('treats a validated pending block with no reference as terminal before credentials', async () => {
    const pending = e2bTestPendingConfig();
    const resolve = vi.fn(async () => E2B_TEST_KEY);
    const provider = adapter(pending, resolve);
    await expect(provider.observe(null)).resolves.toEqual({ status: 'terminal' });
    await expect(provider.stop(null)).resolves.toBe('terminal');
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not short-circuit a mismatched pending identity to terminal', async () => {
    const pending = e2bTestPendingConfig();
    const resolve = vi.fn(async () => E2B_TEST_KEY);
    const provider = adapter(pending, resolve);
    const other = { ...e2bTestPendingConfig(), templateId: 'other-template' };
    // The identity fails validation, so the pending short-circuit is not taken:
    // the malformed reference is uncertain, never terminal.
    await expect(provider.observe(null, intentFor(other))).resolves.toEqual({ status: 'unknown' });
    await expect(provider.stop(null, intentFor(other))).resolves.toBe('retryable');
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
