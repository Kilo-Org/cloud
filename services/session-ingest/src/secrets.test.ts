import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import {
  readSessionIngestSecret,
  secretsSource,
  type SessionIngestSecretName,
  type SessionIngestSecretsEnv,
} from './secrets';

const NAMES: SessionIngestSecretName[] = [
  'NEXTAUTH_SECRET',
  'INTERNAL_API_SECRET',
  'SESSION_SHARE_JWT_SECRET',
];
/** The binding each bundle name reads today, repeated so a loop can place it in the env. */
const BINDING: Record<SessionIngestSecretName, string> = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET_PROD',
  INTERNAL_API_SECRET: 'INTERNAL_API_SECRET_PROD',
  SESSION_SHARE_JWT_SECRET: 'SESSION_SHARE_JWT_SECRET_PROD',
};
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'session-ingest',
    environment: 'production' as const,
    etag: ETAG,
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

/** A fresh binding per call: the client keeps one bundle per binding for the isolate. */
function stsBinding(bundle = okBundle({ INTERNAL_API_SECRET: 'bundle-internal' })) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get }, get };
}

/** Places the legacy binding under the name this Worker reads today. */
function legacyEnv(
  name: SessionIngestSecretName,
  secret: { get(): Promise<string> }
): SessionIngestSecretsEnv {
  return { [BINDING[name]]: secret };
}

describe('secretsSource', () => {
  it('defaults to the legacy binding source', () => {
    expect(secretsSource({})).toBe('secrets-store');
  });

  it.each(['secrets-store', 'sts'] as const)('accepts %s', source => {
    expect(secretsSource({ SECRETS_SOURCE: source })).toBe(source);
  });

  it('fails closed on an unknown source', () => {
    expect(() => secretsSource({ SECRETS_SOURCE: 'infisical' })).toThrow(/SECRETS_SOURCE/);
  });
});

describe('readSessionIngestSecret', () => {
  it.each(NAMES)(
    'reads %s from its binding by default and from the bundle under sts',
    async name => {
      const store = storeSecret('legacy-value');
      const sts = stsBinding(okBundle({ [name]: 'bundle-value' }));
      const env = { ...legacyEnv(name, store.secret), STS: sts.binding };

      expect(await readSessionIngestSecret(env, name)).toBe('legacy-value');
      expect(sts.getBundle).not.toHaveBeenCalled();

      expect(await readSessionIngestSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe(
        'bundle-value'
      );
      expect(store.get).toHaveBeenCalledOnce();
      expect(sts.getBundle).toHaveBeenCalledOnce();

      // Flipping the variable back reads the legacy binding again.
      expect(await readSessionIngestSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name)).toBe(
        'legacy-value'
      );
      expect(store.get).toHaveBeenCalledTimes(2);
      expect(sts.getBundle).toHaveBeenCalledOnce();
    }
  );

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(
      await readSessionIngestSecret({ INTERNAL_API_SECRET_PROD: 'plain-value' }, 'INTERNAL_API_SECRET')
    ).toBe('plain-value');
  });

  it('refuses a name the bundle does not serve without reading the legacy binding', async () => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, ['INTERNAL_API_SECRET']));
    const env = {
      ...legacyEnv('INTERNAL_API_SECRET', store.secret),
      STS: sts.binding,
      SECRETS_SOURCE: 'sts',
    };

    await expect(readSessionIngestSecret(env, 'INTERNAL_API_SECRET')).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = { ...legacyEnv('INTERNAL_API_SECRET', store.secret), SECRETS_SOURCE: 'sts' };

    await expect(readSessionIngestSecret(env, 'INTERNAL_API_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readSessionIngestSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'INTERNAL_API_SECRET')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent', async () => {
    await expect(readSessionIngestSecret({}, 'INTERNAL_API_SECRET')).rejects.toThrow(
      /INTERNAL_API_SECRET_PROD is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding(okBundle({ INTERNAL_API_SECRET: 'bundle-internal' }));
    const env = { STS: sts.binding, SECRETS_SOURCE: 'sts' };

    expect(await readSessionIngestSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(await readSessionIngestSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });
});
