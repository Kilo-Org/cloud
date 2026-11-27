import type { BundleBinding } from '@kilocode/secrets-client';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ waitUntil: vi.fn() }));
vi.mock('../db/queries.js', () => ({
  getWorkerDb: vi.fn(() => ({})),
  findUserForToken: vi.fn(async () => ({
    id: 'user-1',
    api_token_pepper: 'current-pepper',
    blocked_at: null,
    blocked_reason: null,
  })),
  organizationExists: vi.fn(),
  ensureBotUserForOrg: vi.fn(),
  isDirectOrgMember: vi.fn(),
}));

import { SecretSourceUnavailableError } from '../secrets.js';
import { logger } from '../util/logger.js';
import { TokenMintingService } from './token-minting-service.js';

// Synthetic fixture values only. Each source holds a different value, so a token signed from the
// wrong source, or from a fallback, fails verification against the expected one.
const STORE_SECRET = 'store-nextauth-fixture-0123456789abcdef';
const BUNDLE_SECRET = 'bundle-nextauth-fixture-0123456789abcdef';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>): BundleResult {
  return {
    status: 'ok',
    workload: 'cloudflare-webhook-agent-ingest',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing: [],
  };
}

/** A fresh STS binding per call: the reader keeps one bundle per binding for the isolate. */
function service(
  source: string | undefined,
  bundle: BundleResult = okBundle({ NEXTAUTH_SECRET: BUNDLE_SECRET })
) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  const storeGet = vi.fn(async () => STORE_SECRET);
  const minting = new TokenMintingService({
    HYPERDRIVE: { connectionString: 'postgres://test' },
    NEXTAUTH_SECRET: { get: storeGet },
    ENVIRONMENT: 'production',
    ...(source === undefined ? {} : { SECRETS_SOURCE: source }),
    STS: { getBundle },
  });
  return { minting, getBundle, storeGet };
}

/** The user id when `nextAuthSecret` verifies the token, else null. */
function verifiedUser(token: string, nextAuthSecret: string) {
  return verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret,
    connectionString: 'unused',
    resourceAudience: { audience: 'cloud-agent-next', mode: 'allow-legacy' },
    getUserPepper: async () => ({ pepper: 'current-pepper', blocked: false }),
  }).catch(() => null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook token minting secrets source', () => {
  it.each([undefined, 'secrets-store'])(
    'signs with the Secrets Store value and reads no bundle (%j)',
    async source => {
      const { minting, getBundle, storeGet } = service(source);

      const { token } = await minting.mintToken({ userId: 'user-1', triggerId: 'trigger-1' });

      expect(await verifiedUser(token, STORE_SECRET)).toEqual({ userId: 'user-1' });
      expect(await verifiedUser(token, BUNDLE_SECRET)).toBeNull();
      expect(storeGet).toHaveBeenCalledOnce();
      expect(getBundle).not.toHaveBeenCalled();
    }
  );

  it('signs with the bundle value under sts and never reads the Secrets Store', async () => {
    const { minting, getBundle, storeGet } = service('sts');

    const { token } = await minting.mintToken({ userId: 'user-1', triggerId: 'trigger-1' });

    expect(await verifiedUser(token, BUNDLE_SECRET)).toEqual({ userId: 'user-1' });
    expect(await verifiedUser(token, STORE_SECRET)).toBeNull();
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeGet).not.toHaveBeenCalled();
  });

  it.each<[string, BundleResult]>([
    ['sts', okBundle({})],
    ['STS', okBundle({ NEXTAUTH_SECRET: BUNDLE_SECRET })],
  ])('fails with the fixed error and no fallback (SECRETS_SOURCE %j)', async (source, bundle) => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { minting, storeGet } = service(source, bundle);

    await expect(
      minting.mintToken({ userId: 'user-1', triggerId: 'trigger-1' })
    ).rejects.toBeInstanceOf(SecretSourceUnavailableError);
    expect(storeGet).not.toHaveBeenCalled();
  });
});
