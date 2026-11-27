import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import { readSessionSyncSecret, secretsSource, type SessionSyncSecretName } from './secrets';

const NAMES: SessionSyncSecretName[] = [
  'NEXTAUTH_SECRET',
  'SESSION_SYNC_SECRET',
  'INTERNAL_API_SECRET',
];
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'session-sync',
    environment: 'production',
    etag: ETAG,
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

const fullBundle = Object.fromEntries(NAMES.map(name => [name, 'bundle-value']));

/** A fresh binding per call: the client keeps one bundle per binding for the isolate. */
function stsBinding(bundle = okBundle(fullBundle)) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get }, get };
}

/** Every binding this deployment holds, all from one store value. */
function legacyEnv(secret: { get(): Promise<string> }) {
  return {
    NEXTAUTH_SECRET: secret,
    SESSION_SYNC_SECRET: secret,
    INTERNAL_API_SECRET_PROD: secret,
  };
}

describe('secretsSource', () => {
  it('defaults to the legacy binding source', () => {
    expect(secretsSource({})).toBe('env');
  });

  it.each(['env', 'sts'] as const)('accepts %s', source => {
    expect(secretsSource({ SECRETS_SOURCE: source })).toBe(source);
  });

  it('fails closed on an unknown source', () => {
    expect(() => secretsSource({ SECRETS_SOURCE: 'infisical' })).toThrow(/SECRETS_SOURCE/);
  });
});

describe('readSessionSyncSecret', () => {
  it.each(NAMES)('reads %s from its binding by default and from the bundle under sts', async name => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding();
    const env = { ...legacyEnv(store.secret), STS: sts.binding };

    expect(await readSessionSyncSecret(env, name)).toBe('legacy-value');
    expect(sts.getBundle).not.toHaveBeenCalled();

    expect(await readSessionSyncSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe(
      'bundle-value'
    );
    expect(store.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).toHaveBeenCalledOnce();

    // Flipping the variable back reads the legacy binding again.
    expect(await readSessionSyncSecret({ ...env, SECRETS_SOURCE: 'env' }, name)).toBe(
      'legacy-value'
    );
    expect(store.get).toHaveBeenCalledTimes(2);
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(
      await readSessionSyncSecret({ NEXTAUTH_SECRET: 'plain-value' }, 'NEXTAUTH_SECRET')
    ).toBe('plain-value');
  });

  it.each(NAMES)('refuses %s when the bundle does not serve it', async name => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, [name]));
    const env = { ...legacyEnv(store.secret), STS: sts.binding, SECRETS_SOURCE: 'sts' };

    await expect(readSessionSyncSecret(env, name)).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = { ...legacyEnv(store.secret), SECRETS_SOURCE: 'sts' };

    await expect(readSessionSyncSecret(env, 'NEXTAUTH_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readSessionSyncSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'NEXTAUTH_SECRET')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent', async () => {
    await expect(readSessionSyncSecret({}, 'SESSION_SYNC_SECRET')).rejects.toThrow(
      /SESSION_SYNC_SECRET is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding();
    const env = { STS: sts.binding, SECRETS_SOURCE: 'sts' };

    expect(await readSessionSyncSecret(env, 'NEXTAUTH_SECRET')).toBe('bundle-value');
    expect(await readSessionSyncSecret(env, 'SESSION_SYNC_SECRET')).toBe('bundle-value');
    expect(await readSessionSyncSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-value');
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });
});
