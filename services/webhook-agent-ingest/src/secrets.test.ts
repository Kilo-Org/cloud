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
function sourceEnv(source: string | undefined, bundle: BundleResult = okBundle(BUNDLE_VALUES)) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  const storeGet = vi.fn(async () => STORE_VALUE);
  const env = {
    ...(source === undefined ? {} : { SECRETS_SOURCE: source }),
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

describe('readSecret', () => {
  it.each([undefined, 'secrets-store'])(
    'reads the Secrets Store binding and no bundle (SECRETS_SOURCE %j)',
    async source => {
      const { env, getBundle, storeGet } = sourceEnv(source);

      expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(STORE_VALUE);
      expect(await readSecret(env, 'CALLBACK_TOKEN_SECRET')).toBe(STORE_VALUE);
      expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe(STORE_VALUE);
      expect(storeGet).toHaveBeenCalledTimes(3);
      expect(getBundle).not.toHaveBeenCalled();
    }
  );

  it('keeps a plain string binding and a rejected get() as before', async () => {
    expect(await readSecret({ NEXTAUTH_SECRET: 'plain-fixture' }, 'NEXTAUTH_SECRET')).toBe(
      'plain-fixture'
    );
    const failure = new Error('store read failed');
    const { env, getBundle, storeGet } = sourceEnv(undefined);
    storeGet.mockRejectedValueOnce(failure);

    await expect(readSecret(env, 'INTERNAL_API_SECRET')).rejects.toBe(failure);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it('reads every name from one bundle under sts and never reads the Secrets Store', async () => {
    const { env, getBundle, storeGet } = sourceEnv('sts');

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
    const { env } = sourceEnv('sts', okBundle({ NEXTAUTH_SECRET: '' }));

    expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe('');
  });

  it.each<[string, string | undefined, BundleResult | 'no-binding', string]>([
    ['the policy grants no name', 'sts', okBundle({}), 'not_granted'],
    ['the manager holds no value', 'sts', okBundle({}, ['NEXTAUTH_SECRET']), 'missing'],
    ['STS refuses the caller', 'sts', { status: 'denied', reason: 'unknown_workload' }, 'denied'],
    ['the STS binding is absent', 'sts', 'no-binding', 'binding_missing'],
    ['SECRETS_SOURCE is malformed', 'STS', okBundle(BUNDLE_VALUES), 'invalid_source'],
  ])(
    'throws a fixed error when %s, logs fixed fields only, and never falls back',
    async (_case, source, bundle, reason) => {
      const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { env, getBundle, storeGet } = sourceEnv(
        source,
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
      if (source !== 'sts') expect(getBundle).not.toHaveBeenCalled();
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
    const refused = sourceEnv('sts', { status: 'denied', reason: 'unknown_workload' });

    await expect(secrets.readSecret(refused.env, 'INTERNAL_API_SECRET')).rejects.toBeInstanceOf(
      secrets.SecretSourceUnavailableError
    );
    expect(info).not.toHaveBeenCalled();

    const { env } = sourceEnv('sts');

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
    const { env } = sourceEnv('sts');

    expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(await readSecret(env, 'CALLBACK_TOKEN_SECRET')).toBe(
      BUNDLE_VALUES.CALLBACK_TOKEN_SECRET
    );
    expect(await readSecret(env, 'NEXTAUTH_SECRET')).toBe(BUNDLE_VALUES.NEXTAUTH_SECRET);
    expect(info).toHaveBeenCalledOnce();
  });

  it('logs nothing for a raw bundle read or a Secrets Store read', async () => {
    const info = await freshLog();
    const { readStsSecret, readSecret } = await import('./secrets');
    const { env: stsEnv } = sourceEnv('sts');
    const { env: storeEnv } = sourceEnv(undefined);

    expect(await readStsSecret(stsEnv, 'INTERNAL_API_SECRET')).toEqual({
      ok: true,
      value: BUNDLE_VALUES.INTERNAL_API_SECRET,
    });
    expect(await readSecret(storeEnv, 'INTERNAL_API_SECRET')).toBe(STORE_VALUE);
    expect(info).not.toHaveBeenCalled();

    expect(await readSecret(stsEnv, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(info).toHaveBeenCalledOnce();
  });

  it('logs for a selected credential read and not for a keyless request', async () => {
    const info = await freshLog();
    const { expectedSecret } = await import('./secrets');
    const { env } = sourceEnv('sts');

    expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', null)).toEqual({
      status: 'keyless',
    });
    expect(info).not.toHaveBeenCalled();

    expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', 'presented')).toEqual({
      status: 'read',
      secret: BUNDLE_VALUES.CALLBACK_TOKEN_SECRET,
    });
    expect(info).toHaveBeenCalledOnce();
  });

  it('logs nothing for an empty delivered value', async () => {
    const info = await freshLog();
    const { readSecret } = await import('./secrets');
    const empty = sourceEnv('sts', okBundle({ INTERNAL_API_SECRET: '' }));

    expect(await readSecret(empty.env, 'INTERNAL_API_SECRET')).toBe('');
    expect(info).not.toHaveBeenCalled();

    const { env } = sourceEnv('sts');

    expect(await readSecret(env, 'INTERNAL_API_SECRET')).toBe(BUNDLE_VALUES.INTERNAL_API_SECRET);
    expect(info).toHaveBeenCalledOnce();
  });
});

describe('expectedSecret', () => {
  it('reads the Secrets Store for a keyless request under secrets-store, as before', async () => {
    const { env, getBundle, storeGet } = sourceEnv(undefined);

    expect(await expectedSecret(env, 'INTERNAL_API_SECRET', null)).toEqual({
      status: 'read',
      secret: STORE_VALUE,
    });
    expect(storeGet).toHaveBeenCalledOnce();
    expect(getBundle).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ''])(
    'reads nothing for a keyless request under sts (%j)',
    async presented => {
      const { env, getBundle, storeGet } = sourceEnv('sts');

      expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', presented)).toEqual({
        status: 'keyless',
      });
      expect(getBundle).not.toHaveBeenCalled();
      expect(storeGet).not.toHaveBeenCalled();
    }
  );

  it('returns the bundle value for a request that presents a credential under sts', async () => {
    const { env, storeGet } = sourceEnv('sts');

    expect(await expectedSecret(env, 'CALLBACK_TOKEN_SECRET', 'presented')).toEqual({
      status: 'read',
      secret: BUNDLE_VALUES.CALLBACK_TOKEN_SECRET,
    });
    expect(storeGet).not.toHaveBeenCalled();
  });

  it.each<[string | undefined, BundleResult, string]>([
    ['sts', okBundle({}), 'not_granted'],
    ['STS', okBundle(BUNDLE_VALUES), 'invalid_source'],
  ])('refuses with a fixed reason (SECRETS_SOURCE %j)', async (source, bundle, reason) => {
    const { env, storeGet } = sourceEnv(source, bundle);

    expect(await expectedSecret(env, 'INTERNAL_API_SECRET', 'presented')).toEqual({
      status: 'refused',
      reason,
    });
    expect(storeGet).not.toHaveBeenCalled();
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
