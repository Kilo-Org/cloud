import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import {
  readAutoRoutingSecret,
  secretsSource,
  type AutoRoutingSecretName,
  type AutoRoutingSecretsEnv,
} from './secrets';

const NAMES: AutoRoutingSecretName[] = [
  'INTERNAL_API_SECRET',
  'OPENROUTER_API_KEY',
  'O11Y_CF_AE_API_TOKEN',
  'NEXTAUTH_SECRET',
  'AUTO_ROUTING_DECISION_SECRET',
];
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'auto-routing',
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

/** Every legacy binding mapped to the same store, so any name resolves to `store.get`. */
function legacyEnv(secret: { get(): Promise<string> }, sts?: BundleBinding): AutoRoutingSecretsEnv {
  return {
    INTERNAL_API_SECRET_PROD: secret,
    OPENROUTER_API_KEY: secret,
    O11Y_CF_AE_API_TOKEN: secret,
    NEXTAUTH_SECRET: secret,
    AUTO_ROUTING_DECISION_SECRET: secret,
    ...(sts === undefined ? {} : { STS: sts }),
  };
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

describe('readAutoRoutingSecret', () => {
  it.each(NAMES)('reads %s from the binding by default and the bundle under sts', async name => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({ [name]: 'bundle-value' }));
    const env = legacyEnv(store.secret, sts.binding);

    expect(await readAutoRoutingSecret(env, name)).toBe('legacy-value');
    expect(sts.getBundle).not.toHaveBeenCalled();

    expect(await readAutoRoutingSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe(
      'bundle-value'
    );
    expect(store.get).toHaveBeenCalledOnce();
    expect(sts.getBundle).toHaveBeenCalledOnce();

    // Flipping the variable back reads the legacy binding again.
    expect(await readAutoRoutingSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name)).toBe(
      'legacy-value'
    );
    expect(store.get).toHaveBeenCalledTimes(2);
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(
      await readAutoRoutingSecret(
        { INTERNAL_API_SECRET_PROD: 'plain-value' },
        'INTERNAL_API_SECRET'
      )
    ).toBe('plain-value');
  });

  it('refuses a name the bundle does not serve without reading the legacy binding', async () => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, ['OPENROUTER_API_KEY']));
    const env = { ...legacyEnv(store.secret, sts.binding), SECRETS_SOURCE: 'sts' };

    await expect(readAutoRoutingSecret(env, 'OPENROUTER_API_KEY')).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = { ...legacyEnv(store.secret), SECRETS_SOURCE: 'sts' };

    await expect(readAutoRoutingSecret(env, 'NEXTAUTH_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readAutoRoutingSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'NEXTAUTH_SECRET')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent, naming the binding it read', async () => {
    await expect(readAutoRoutingSecret({}, 'INTERNAL_API_SECRET')).rejects.toThrow(
      /INTERNAL_API_SECRET_PROD is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding(okBundle({ INTERNAL_API_SECRET: 'bundle-internal' }));
    const env = { STS: sts.binding, SECRETS_SOURCE: 'sts' };

    expect(await readAutoRoutingSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(await readAutoRoutingSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });
});
