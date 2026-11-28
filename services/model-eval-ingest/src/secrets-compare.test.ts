import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import {
  createSecretsComparison,
  SECRETS_COMPARE_DEADLINE_MS,
  SECRETS_COMPARE_EVENT,
  type SecretsCompareEnv,
} from './secrets-compare';

const SELECTED = 'selected-internal-value';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'model-eval-ingest',
    environment: 'production' as const,
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-28T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

/** A fresh binding per test: the client keeps one bundle per binding for the isolate. */
function stsBinding(bundle = okBundle({ INTERNAL_API_SECRET: SELECTED })) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get }, get };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  return { ctx: { waitUntil }, waitUntil, settled: () => Promise.all(pending) };
}

function productionEnv(overrides: Partial<SecretsCompareEnv> = {}) {
  const store = storeSecret(SELECTED);
  const sts = stsBinding();
  const env: SecretsCompareEnv = {
    ENVIRONMENT: 'production',
    SECRETS_COMPARE_ENABLED: 'true',
    SECRETS_SOURCE: 'secrets-store',
    INTERNAL_API_SECRET: store.secret,
    STS: sts.binding,
    ...overrides,
  };
  return { env, store, sts };
}

function captureLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createSecretsComparison', () => {
  it.each<[string, Partial<SecretsCompareEnv>]>([
    ['the flag is absent', { SECRETS_COMPARE_ENABLED: undefined }],
    ['the flag is not exactly true', { SECRETS_COMPARE_ENABLED: 'TRUE' }],
    ['the environment is development', { ENVIRONMENT: 'development' }],
    ['the environment is absent', { ENVIRONMENT: undefined }],
  ])('reads nothing, the execution context included, when %s', (_case, overrides) => {
    const log = captureLog();
    const { env, store, sts } = productionEnv(overrides);
    const ctx = {
      get waitUntil(): never {
        throw new Error('the execution context was read');
      },
    };
    const comparison = createSecretsComparison();

    comparison.admitted(env, ctx, SELECTED);

    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('compares the selected legacy value with the bundle once per isolate after an accepted key', async () => {
    const log = captureLog();
    const { env, store, sts } = productionEnv();
    const { ctx, waitUntil, settled } = executionContext();
    const comparison = createSecretsComparison();

    comparison.admitted(env, ctx, SELECTED);
    comparison.admitted(env, ctx, SELECTED);
    await settled();

    // Only the comparison's own `waitUntil`; the bundle read finished inside it.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(sts.getBundle).toHaveBeenCalledOnce();
    // The selected value is reused: the legacy binding is not read again.
    expect(store.get).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      [
        SECRETS_COMPARE_EVENT,
        { route: 'sync', secret: 'INTERNAL_API_SECRET', source: 'secrets-store', result: 'match' },
      ],
    ]);
  });

  it('reports a mismatch with fixed fields only, never either value', async () => {
    const log = captureLog();
    const { env } = productionEnv({
      STS: stsBinding(okBundle({ INTERNAL_API_SECRET: 'bundle-copy-differs' })).binding,
    });
    const { ctx, settled } = executionContext();

    createSecretsComparison().admitted(env, ctx, SELECTED);
    await settled();

    expect(log.mock.calls).toEqual([
      [
        SECRETS_COMPARE_EVENT,
        {
          route: 'sync',
          secret: 'INTERNAL_API_SECRET',
          source: 'secrets-store',
          result: 'mismatch',
        },
      ],
    ]);
    const rendered = JSON.stringify(log.mock.calls);
    expect(rendered).not.toContain(SELECTED);
    expect(rendered).not.toContain('bundle-copy-differs');
  });

  it.each<[string, () => BundleBinding | undefined]>([
    [
      'the bundle does not serve the name',
      () => stsBinding(okBundle({}, ['INTERNAL_API_SECRET'])).binding,
    ],
    ['the bundle copy is empty', () => stsBinding(okBundle({ INTERNAL_API_SECRET: '' })).binding],
    ['the STS binding is absent', () => undefined],
  ])('reports unproven when %s', async (_case, binding) => {
    const log = captureLog();
    const { env } = productionEnv({ STS: binding() });
    const { ctx, settled } = executionContext();

    createSecretsComparison().admitted(env, ctx, SELECTED);
    await settled();

    expect(log.mock.calls).toEqual([
      [
        SECRETS_COMPARE_EVENT,
        {
          route: 'sync',
          secret: 'INTERNAL_API_SECRET',
          source: 'secrets-store',
          result: 'unproven',
        },
      ],
    ]);
  });

  it('compares the selected bundle value with the legacy binding under sts', async () => {
    const log = captureLog();
    const { env, store, sts } = productionEnv({ SECRETS_SOURCE: 'sts' });
    const { ctx, settled } = executionContext();

    createSecretsComparison().admitted(env, ctx, SELECTED);
    await settled();

    expect(store.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(SECRETS_COMPARE_EVENT, {
      route: 'sync',
      secret: 'INTERNAL_API_SECRET',
      source: 'sts',
      result: 'match',
    });
  });

  it('reports unproven when the other source has not answered by the deadline', async () => {
    vi.useFakeTimers();
    const log = captureLog();
    const getBundle = vi.fn<BundleBinding['getBundle']>(() => new Promise(() => undefined));
    const { env } = productionEnv({ STS: { getBundle } });
    const { ctx, waitUntil } = executionContext();

    createSecretsComparison().admitted(env, ctx, SELECTED);
    const comparison = waitUntil.mock.calls[0]?.[0];
    await vi.advanceTimersByTimeAsync(SECRETS_COMPARE_DEADLINE_MS);
    // Only the comparison's own promise: the client may hand its hung call to `waitUntil` too.
    await comparison;

    expect(log).toHaveBeenCalledWith(SECRETS_COMPARE_EVENT, {
      route: 'sync',
      secret: 'INTERNAL_API_SECRET',
      source: 'secrets-store',
      result: 'unproven',
    });
  });

  it('stays armed when the request has no execution context', async () => {
    const log = captureLog();
    const { env, sts } = productionEnv();
    const { ctx, settled } = executionContext();
    const comparison = createSecretsComparison();

    comparison.admitted(env, undefined, SELECTED);
    expect(sts.getBundle).not.toHaveBeenCalled();

    comparison.admitted(env, ctx, SELECTED);
    await settled();

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reads nothing and stays armed when waitUntil refuses the registration', async () => {
    const log = captureLog();
    const { env, store, sts } = productionEnv();
    const refusing = {
      waitUntil: vi.fn(() => {
        throw new Error('waitUntil refused');
      }),
    };
    const comparison = createSecretsComparison();

    expect(() => comparison.admitted(env, refusing, SELECTED)).not.toThrow();
    // A refused registration exposes no promise to await, so drain every pending microtask with a
    // zero-delay task: any read the call had started would have reached the bindings by then.
    const flushed = Promise.withResolvers<void>();
    setTimeout(flushed.resolve, 0);
    await flushed.promise;
    expect(refusing.waitUntil).toHaveBeenCalledOnce();
    expect(sts.getBundle).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    const { ctx, settled } = executionContext();
    comparison.admitted(env, ctx, SELECTED);
    await settled();

    expect(sts.getBundle).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });

  it('starts the comparison only after waitUntil has accepted it', async () => {
    captureLog();
    const { env, sts } = productionEnv();
    const readsAtRegistration: number[] = [];
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        readsAtRegistration.push(sts.getBundle.mock.calls.length);
        pending.push(promise);
      }),
    };

    createSecretsComparison().admitted(env, ctx, SELECTED);
    await Promise.all(pending);

    // The first registration is the comparison itself; no bundle read had begun by then.
    expect(readsAtRegistration[0]).toBe(0);
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });

  it('never throws on an unknown source and stays armed', async () => {
    const log = captureLog();
    const { env, sts } = productionEnv({ SECRETS_SOURCE: 'infisical' });
    const { ctx, waitUntil, settled } = executionContext();
    const comparison = createSecretsComparison();

    expect(() => comparison.admitted(env, ctx, SELECTED)).not.toThrow();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sts.getBundle).not.toHaveBeenCalled();

    comparison.admitted({ ...env, SECRETS_SOURCE: 'secrets-store' }, ctx, SELECTED);
    await settled();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });
});
