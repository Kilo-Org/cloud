import type { BundleBinding } from '@kilocode/secrets-client';
import type { BundleResult } from '@kilocode/sts-contracts';

const ETAG = '"0123456789abcdef"';

/**
 * The STS binding a test env carries: one o11y bundle holding `values` and nothing missing. The
 * reader keeps one client per binding, so every call returns a new binding and a fresh bundle.
 */
export function stsBundle(values: Record<string, string>): Env['STS'] {
  const result: BundleResult = {
    status: 'ok',
    workload: 'o11y',
    environment: 'production',
    etag: ETAG,
    stale: false,
    fetchedAt: '2026-11-25T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing: [],
  };
  const binding: BundleBinding = {
    async getBundle() {
      return result;
    },
  };
  return binding as unknown as Env['STS'];
}
