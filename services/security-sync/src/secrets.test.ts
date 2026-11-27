import type { BundleBinding } from '@kilocode/secrets-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invocation = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock('cloudflare:workers', () => invocation);

import { readStsInternalApiSecret, secretsSource } from './secrets.js';

// Synthetic fixture value only.
const BUNDLE_SECRET = 'bundle-internal-fixture-0123456789abcdef';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'cloudflare-security-sync',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('secretsSource', () => {
  it('defaults to secrets-store', () => {
    expect(secretsSource({})).toBe('secrets-store');
  });

  it.each(['secrets-store', 'sts'] as const)('accepts %s', source => {
    expect(secretsSource({ SECRETS_SOURCE: source })).toBe(source);
  });

  it.each(['legacy', 'STS', ''])('returns undefined for %j', source => {
    expect(secretsSource({ SECRETS_SOURCE: source })).toBeUndefined();
  });
});

describe('readStsInternalApiSecret', () => {
  it('reads INTERNAL_API_SECRET from the bundle once per binding', async () => {
    const getBundle = vi.fn<BundleBinding['getBundle']>(async () =>
      okBundle({ INTERNAL_API_SECRET: BUNDLE_SECRET })
    );
    const env = { STS: { getBundle } satisfies BundleBinding };

    expect(await readStsInternalApiSecret(env)).toEqual({ ok: true, value: BUNDLE_SECRET });
    expect(await readStsInternalApiSecret(env)).toEqual({ ok: true, value: BUNDLE_SECRET });
    expect(getBundle).toHaveBeenCalledOnce();
    expect(invocation.waitUntil).not.toHaveBeenCalled();
  });

  it('returns binding_missing without the STS binding', async () => {
    expect(await readStsInternalApiSecret({})).toEqual({ ok: false, reason: 'binding_missing' });
  });

  it.each<[string, BundleResult, string]>([
    ['the policy grants no INTERNAL_API_SECRET', okBundle({}), 'not_granted'],
    ['the manager holds no value', okBundle({}, ['INTERNAL_API_SECRET']), 'missing'],
    ['STS refuses the caller', { status: 'denied', reason: 'unknown_workload' }, 'denied'],
  ])('returns only a fixed reason when %s', async (_case, bundle, reason) => {
    const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);

    expect(await readStsInternalApiSecret({ STS: { getBundle } })).toStrictEqual({
      ok: false,
      reason,
    });
  });
});
