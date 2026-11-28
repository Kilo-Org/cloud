import type { BundleBinding } from '@kilocode/secrets-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invocation = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock('cloudflare:workers', () => invocation);

import {
  expectedSecret,
  readSecret,
  SecretSourceUnavailableError,
  secretsSource,
  secretUnavailableResponse,
} from './secrets';
import { logger } from './util/logger';

// Synthetic fixture values only. Each source holds a different value, so a read that used the
// wrong source, or fell back to it, returns a value the test refuses.
const STORE_VALUE = 'store-fixture-0123456789abcdef';
const BUNDLE_VALUES = {
  INTERNAL_API_SECRET: 'bundle-internal-fixture-0123456789abcdef',
  CALLBACK_TOKEN_SECRET: 'bundle-callback-fixture-0123456789abcdef',
  NEXTAUTH_SECRET: 'bundle-nextauth-fixture-0123456789abcdef',
};

/** Environments this Worker does not deploy: each reads neither source. */
const UNSUPPORTED_ENVIRONMENTS = ['staging', 'Production', '', undefined];

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
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
    missing,
  };
}

/** A fresh STS binding per call: the reader keeps one bundle per binding for the isolate. */
function sourceEnv(
  environment: string | undefined,
  bundle: BundleResult = okBundle(BUNDLE_VALUES)
) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  const storeGet = vi.fn(async () => STORE_VALUE);
  const env = {
    ...(environment === undefined ? {} : { ENVIRONMENT: environment }),
    INTERNAL_API_SECRET: { get: storeGet },
    CALLBACK_TOKEN_SECRET: { get: storeGet },
    NEXTAUTH_SECRET: { get: storeGet },
    STS: { getBundle } satisfies BundleBinding,
  };
  return { env, getBundle, storeGet };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('secretsSource', () => {
  it('reads STS in production', () => {
    expect(secretsSource({ ENVIRONMENT: 'production' })).toBe('sts');
  });

  it('reads the Worker bindings in development', () => {
    expect(secretsSource({ ENVIRONMENT: 'development' })).toBe('secrets-store');
  });

  it.each(UNSUPPORTED_ENVIRONMENTS)('returns undefined for ENVIRONMENT %j', environment => {
    expect(secretsSource({ ENVIRONMENT: environment })).toBeUndefined();
  });
});

describe('readSecret', () => {
  it('reads the Secrets Store binding and no bundle in development', async () => {
    const { env, getBundle, storeGet } = sourceEnv('development');

    expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(STORE_VALUE);
    expect(await readSecret(env, 'CALLBACK_TOKEN_SECRET')).toBe(STORE_VALUE);
    expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe(STORE_VALUE);
    expect(storeGet).toHaveBeenCalledTimes(3);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it('keeps a plain string binding and a rejected get() in development', async () => {
    expect(
      await readSecret(
        { ENVIRONMENT: 'development', NEXTAUTH_SECRET: 'plain-fixture' },
        'NEXTAUTH_SECRET'
      )
    ).toBe('plain-fixture');
    const failure = new Error('store read failed');
    const { env, getBundle, storeGet } = sourceEnv('development');
    storeGet.mockRejectedValueOnce(failure);

    await expect(readSecret(env, 'INTERNAL_API_SECRET')).rejects.toBe(failure);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it('reads every name from one bundle in production and never reads the Secrets Store', async () => {
    const { env, getBundle, storeGet } = sourceEnv('production');

    expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(await readSecret(env, 'CALLBACK_TOKEN_SECRET')).toBe(
      BUNDLE_VALUES.CALLBACK_TOKEN_SECRET
    );
    expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe(BUNDLE_VALUES.NEXTAUTH_SECRET);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeGet).not.toHaveBeenCalled();
    expect(invocation.waitUntil).not.toHaveBeenCalled();
  });

  it('returns an empty delivered value as is, for the caller to handle', async () => {
    const { env } = sourceEnv('production', okBundle({ NEXTAUTH_SECRET: '' }));

    expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe('');
  });

  it.each<[string, string | undefined, BundleResult | 'no-binding', string]>([
    ['the policy grants no name', 'production', okBundle({}), 'not_granted'],
    ['the manager holds no value', 'production', okBundle({}, ['NEXTAUTH_SECRET']), 'missing'],
    [
      'STS refuses the caller',
      'production',
      { status: 'denied', reason: 'unknown_workload' },
      'denied',
    ],
    ['the STS binding is absent', 'production', 'no-binding', 'binding_missing'],
    ['ENVIRONMENT is staging', 'staging', okBundle(BUNDLE_VALUES), 'unsupported_environment'],
    ['ENVIRONMENT is mis-cased', 'Production', okBundle(BUNDLE_VALUES), 'unsupported_environment'],
    ['ENVIRONMENT is empty', '', okBundle(BUNDLE_VALUES), 'unsupported_environment'],
    ['ENVIRONMENT is absent', undefined, okBundle(BUNDLE_VALUES), 'unsupported_environment'],
  ])(
    'throws a fixed error when %s, logs fixed fields only, and never falls back',
    async (_case, environment, bundle, reason) => {
      const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { env, getBundle, storeGet } = sourceEnv(
        environment,
        bundle === 'no-binding' ? okBundle({}) : bundle
      );
      const target = bundle === 'no-binding' ? { ...env, STS: undefined } : env;

      const read = readSecret(target, 'NEXTAUTH_SECRET');

      await expect(read).rejects.toBeInstanceOf(SecretSourceUnavailableError);
      await expect(read).rejects.toMatchObject({
        message: 'Webhook credentials are temporarily unavailable',
        secret: 'NEXTAUTH_SECRET',
        reason,
      });
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith('Webhook secret unavailable', {
        secret: 'NEXTAUTH_SECRET',
        reason,
      });
      // The client's own error text names the secret and the cause; none of it is logged.
      expect(JSON.stringify(log.mock.calls)).not.toContain('granted to this workload');
      expect(storeGet).not.toHaveBeenCalled();
      if (environment !== 'production') expect(getBundle).not.toHaveBeenCalled();
    }
  );
});

describe('STS success log', () => {
  async function freshLog() {
    vi.resetModules();
    const { logger: freshLogger } = await import('./util/logger');
    vi.spyOn(freshLogger, 'error').mockImplementation(() => undefined);
    return vi.spyOn(freshLogger, 'info').mockImplementation(() => undefined);
  }

  it('logs one fixed event on the first successful read, not on a refused read before it', async () => {
    const info = await freshLog();
    const secrets = await import('./secrets');
    const refused = sourceEnv('production', { status: 'denied', reason: 'unknown_workload' });

    await expect(secrets.readSecret(refused.env, 'INTERNAL_API_SECRET')).rejects.toBeInstanceOf(
      secrets.SecretSourceUnavailableError
    );
    expect(info).not.toHaveBeenCalled();

    const { env } = sourceEnv('production');

    expect(await secrets.readSecret(env, 'INTERNAL_API_SECRET')).toBe(
      BUNDLE_VALUES.INTERNAL_API_SECRET
    );
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('Webhook secret source read succeeded', { source: 'sts' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('INTERNAL_API_SECRET');
    expect(JSON.stringify(info.mock.calls)).not.toContain(BUNDLE_VALUES.INTERNAL_API_SECRET);
  });

  it('does not repeat the event for later successful reads', async () => {
    const info = await freshLog();
    const { readSecret } = await import('./secrets');
    const { env } = sourceEnv('production');

    expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(await readSecret(env, 'CALLBACK_TOKEN_SECRET')).toBe(
      BUNDLE_VALUES.CALLBACK_TOKEN_SECRET
    );
    expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe(BUNDLE_VALUES.NEXTAUTH_SECRET);
    expect(info).toHaveBeenCalledOnce();
  });

  it('logs nothing for a development read', async () => {
    const info = await freshLog();
    const { readSecret } = await import('./secrets');
    const { env: stsEnv } = sourceEnv('production');
    const { env: storeEnv } = sourceEnv('development');

    expect(await readSecret(storeEnv, 'INTERNAL_API_SECRET')).toBe(STORE_VALUE);
    expect(info).not.toHaveBeenCalled();

    expect(await readSecret(stsEnv, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(info).toHaveBeenCalledOnce();
  });

  it('logs for a selected credential read and not for a keyless request', async () => {
    const info = await freshLog();
    const { expectedSecret } = await import('./secrets');
    const { env } = sourceEnv('production');

    expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', null)).toEqual({
      status: 'keyless',
      source: 'sts',
    });
    expect(info).not.toHaveBeenCalled();

    expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', 'presented')).toEqual({
      status: 'read',
      source: 'sts',
      secret: BUNDLE_VALUES.CALLBACK_TOKEN_SECRET,
    });
    expect(info).toHaveBeenCalledOnce();
  });

  it('logs nothing for an empty delivered value', async () => {
    const info = await freshLog();
    const { readSecret } = await import('./secrets');
    const empty = sourceEnv('production', okBundle({ INTERNAL_API_SECRET: '' }));

    expect(await readSecret(empty.env, 'INTERNAL_API_SECRET')).toBe('');
    expect(info).not.toHaveBeenCalled();

    const { env } = sourceEnv('production');

    expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(info).toHaveBeenCalledOnce();
  });
});

describe('expectedSecret', () => {
  it('reads the Secrets Store for a keyless request in development', async () => {
    const { env, getBundle, storeGet } = sourceEnv('development');

    expect(await expectedSecret(env, 'INTERNAL_API_SECRET', null)).toEqual({
      status: 'read',
      source: 'secrets-store',
      secret: STORE_VALUE,
    });
    expect(storeGet).toHaveBeenCalledOnce();
    expect(getBundle).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ''])(
    'reads nothing for a keyless request in production (%j)',
    async presented => {
      const { env, getBundle, storeGet } = sourceEnv('production');

      expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', presented)).toEqual({
        status: 'keyless',
        source: 'sts',
      });
      expect(getBundle).not.toHaveBeenCalled();
      expect(storeGet).not.toHaveBeenCalled();
    }
  );

  it('returns the bundle value for a request that presents a credential in production', async () => {
    const { env, storeGet } = sourceEnv('production');

    expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', 'presented')).toEqual({
      status: 'read',
      source: 'sts',
      secret: BUNDLE_VALUES.CALLBACK_TOKEN_SECRET,
    });
    expect(storeGet).not.toHaveBeenCalled();
  });

  it.each<[string | undefined, BundleResult | 'no-binding', string]>([
    ['production', okBundle({}), 'not_granted'],
    ['production', 'no-binding', 'binding_missing'],
    ['staging', okBundle(BUNDLE_VALUES), 'unsupported_environment'],
    ['Production', okBundle(BUNDLE_VALUES), 'unsupported_environment'],
    ['', okBundle(BUNDLE_VALUES), 'unsupported_environment'],
    [undefined, okBundle(BUNDLE_VALUES), 'unsupported_environment'],
  ])('refuses with a fixed reason (ENVIRONMENT %j)', async (environment, bundle, reason) => {
    const { env, getBundle, storeGet } = sourceEnv(
      environment,
      bundle === 'no-binding' ? okBundle({}) : bundle
    );
    const target = bundle === 'no-binding' ? { ...env, STS: undefined } : env;

    expect(await expectedSecret(target, 'INTERNAL_API_SECRET', 'presented')).toEqual({
      status: 'refused',
      reason,
    });
    expect(storeGet).not.toHaveBeenCalled();
    if (environment !== 'production') expect(getBundle).not.toHaveBeenCalled();
  });
});

describe('secretUnavailableResponse', () => {
  it('answers a generic 503 and logs fixed fields only', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const response = secretUnavailableResponse('internal-api', 'denied');

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Internal key unavailable',
    });
    expect(log).toHaveBeenCalledWith('Webhook verifier secret unavailable', {
      route: 'internal-api',
      reason: 'denied',
    });
  });
});
