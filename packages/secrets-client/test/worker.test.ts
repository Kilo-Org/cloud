import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError } from '../src/errors';
import { createWorkerSecrets } from '../src/worker';

const ETAG = '"0123456789abcdef"';
const SECRET = 'O11Y_CF_AE_API_TOKEN';

describe('createWorkerSecrets', () => {
  it('reads the bundle through the service binding', async () => {
    const result: BundleResult = {
      status: 'ok',
      workload: 'o11y',
      environment: 'production',
      etag: ETAG,
      stale: false,
      fetchedAt: '2026-11-25T00:00:00.000Z',
      secrets: { [SECRET]: { value: 'binding-token', version: 7 } },
      missing: [],
    };
    const getBundle = vi.fn<(request: BundleRequest) => Promise<BundleResult>>(async () => result);
    const secrets = createWorkerSecrets({ getBundle });

    expect(await secrets.get(SECRET)).toBe('binding-token');
    expect(getBundle).toHaveBeenCalledTimes(1);
    expect(getBundle.mock.calls[0][0]).toEqual({});
  });

  it('rejects a binding result that does not match the contract', async () => {
    const getBundle = vi.fn<(request: BundleRequest) => Promise<BundleResult>>(
      async () => ({ status: 'ok' }) as BundleResult
    );
    const secrets = createWorkerSecrets({ getBundle });

    const error = await secrets.get(SECRET).catch(err => err);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });
});
