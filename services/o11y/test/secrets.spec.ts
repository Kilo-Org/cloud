import { SecretUnavailableError } from '@kilocode/secrets-client';
import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { describe, expect, it } from 'vitest';
import { resolveQueueId } from '../src/alerting/queue-lookup';
import { readO11ySecret, secretsSource } from '../src/secrets';

const ETAG = '"0123456789abcdef"';
const CONTAINERS_TOKEN = 'O11Y_CF_CONTAINERS_API_TOKEN';
const QUEUE_ID = 'ab'.repeat(16);

function storeEnv(values: Record<string, string>) {
  const reads: string[] = [];
  const env: Record<string, SecretsStoreSecret> = {};
  for (const [name, value] of Object.entries(values)) {
    env[name] = {
      async get() {
        reads.push(name);
        return value;
      },
    } as SecretsStoreSecret;
  }
  return { env, reads };
}

function bundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'o11y',
    environment: 'production',
    etag: ETAG,
    stale: false,
    fetchedAt: '2026-11-25T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

function stsBinding(result: BundleResult) {
  const requests: BundleRequest[] = [];
  return {
    requests,
    async getBundle(request: BundleRequest) {
      requests.push(request);
      return result;
    },
  };
}

describe('secretsSource', () => {
  it('defaults to the Secrets Store', () => {
    expect(secretsSource({})).toBe('secrets-store');
  });

  it('accepts sts', () => {
    expect(secretsSource({ SECRETS_SOURCE: 'sts' })).toBe('sts');
  });

  it('fails closed on an unknown source', () => {
    expect(() => secretsSource({ SECRETS_SOURCE: 'infisical-direct' })).toThrow(/SECRETS_SOURCE/);
  });
});

describe('readO11ySecret', () => {
  it('reads the Secrets Store binding by default', async () => {
    const { env, reads } = storeEnv({
      [CONTAINERS_TOKEN]: 'store-token',
      O11Y_CF_AE_API_TOKEN: 'ae-token',
    });

    expect(await readO11ySecret(env, CONTAINERS_TOKEN)).toBe('store-token');
    expect(reads).toEqual([CONTAINERS_TOKEN]);
  });

  it('reads the STS bundle when the source is sts', async () => {
    const { env, reads } = storeEnv({ [CONTAINERS_TOKEN]: 'store-token' });
    const binding = stsBinding(bundle({ [CONTAINERS_TOKEN]: 'bundle-token' }));

    const resolved = await readO11ySecret(
      { ...env, SECRETS_SOURCE: 'sts', STS: binding },
      CONTAINERS_TOKEN
    );

    expect(resolved).toBe('bundle-token');
    expect(reads).toEqual([]);
    expect(binding.requests).toEqual([{}]);
  });

  it('reuses one bundle across reads in an isolate', async () => {
    const binding = stsBinding(
      bundle({ [CONTAINERS_TOKEN]: 'bundle-token', O11Y_CF_AE_API_TOKEN: 'bundle-ae' })
    );
    const env = { SECRETS_SOURCE: 'sts', STS: binding };

    expect(await readO11ySecret(env, CONTAINERS_TOKEN)).toBe('bundle-token');
    expect(await readO11ySecret(env, 'O11Y_CF_AE_API_TOKEN')).toBe('bundle-ae');
    expect(binding.requests).toHaveLength(1);
  });

  it('surfaces a non-retryable failure for a name the policy does not grant', async () => {
    const binding = stsBinding(bundle({}, [CONTAINERS_TOKEN]));
    const error = await readO11ySecret(
      { SECRETS_SOURCE: 'sts', STS: binding },
      CONTAINERS_TOKEN
    ).catch(err => err);

    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error.reason).toBe('missing');
    expect(error.retryable).toBe(false);
  });

  it('requires the STS binding when the source is sts', async () => {
    await expect(readO11ySecret({ SECRETS_SOURCE: 'sts' }, CONTAINERS_TOKEN)).rejects.toThrow(
      /STS service binding is missing/
    );
  });

  it('refuses to read from an unknown source', async () => {
    const { env } = storeEnv({ [CONTAINERS_TOKEN]: 'store-token' });
    await expect(
      readO11ySecret({ ...env, SECRETS_SOURCE: 'vault' }, CONTAINERS_TOKEN)
    ).rejects.toThrow(/SECRETS_SOURCE/);
  });

  it('reports an unconfigured Secrets Store value with the secret name', async () => {
    const { env } = storeEnv({ [CONTAINERS_TOKEN]: '' });
    await expect(readO11ySecret(env, CONTAINERS_TOKEN)).rejects.toThrow(
      `${CONTAINERS_TOKEN} secret is not configured`
    );
  });
});

describe('a read site over both sources', () => {
  async function queueIdWith(
    env: Omit<Parameters<typeof resolveQueueId>[0], 'O11Y_CF_ACCOUNT_ID'> & {
      SECRETS_SOURCE?: string;
      STS?: unknown;
    },
    authorization: string[]
  ) {
    const fetchFn = async (_url: string, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('Authorization') ?? '');
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ queue_name: 'kilo-alerts', queue_id: QUEUE_ID }],
          result_info: { total_pages: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const queryEnv: Parameters<typeof resolveQueueId>[0] = {
      O11Y_CF_ACCOUNT_ID: 'account',
      ...env,
    };
    return resolveQueueId(queryEnv, fetchFn, 'kilo-alerts');
  }

  it('authorizes with the Secrets Store token', async () => {
    const authorization: string[] = [];
    const { env } = storeEnv({ [CONTAINERS_TOKEN]: 'store-token' });

    expect(await queueIdWith(env, authorization)).toBe(QUEUE_ID);
    expect(authorization).toEqual(['Bearer store-token']);
  });

  it('authorizes with the STS bundle token', async () => {
    const authorization: string[] = [];
    const binding = stsBinding(bundle({ [CONTAINERS_TOKEN]: 'bundle-token' }));

    expect(await queueIdWith({ SECRETS_SOURCE: 'sts', STS: binding }, authorization)).toBe(
      QUEUE_ID
    );
    expect(authorization).toEqual(['Bearer bundle-token']);
  });
});
