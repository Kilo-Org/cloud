import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import { readKiloOpsSecret, secretsSource, type KiloOpsSecretName } from './secrets';

const NAMES: KiloOpsSecretName[] = ['O11Y_CF_AE_API_TOKEN', 'GF_SECRET_KEY'];
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'kilo-ops',
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
function stsBinding(bundle = okBundle({ O11Y_CF_AE_API_TOKEN: 'bundle-token' })) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get }, get };
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

describe('readKiloOpsSecret', () => {
  it.each(NAMES)(
    'reads %s from its binding by default and from the bundle under sts',
    async name => {
      const store = storeSecret('legacy-value');
      const sts = stsBinding(okBundle({ [name]: 'bundle-value' }));
      const env = {
        CF_ANALYTICS_API_KEY: store.secret,
        GF_SECRET_KEY: store.secret,
        STS: sts.binding,
      };

      expect(await readKiloOpsSecret(env, name)).toBe('legacy-value');
      expect(sts.getBundle).not.toHaveBeenCalled();

      expect(await readKiloOpsSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe('bundle-value');
      expect(store.get).toHaveBeenCalledOnce();
      expect(sts.getBundle).toHaveBeenCalledOnce();

      // Flipping the variable back reads the legacy binding again.
      expect(await readKiloOpsSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name)).toBe(
        'legacy-value'
      );
      expect(store.get).toHaveBeenCalledTimes(2);
      expect(sts.getBundle).toHaveBeenCalledOnce();
    }
  );

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(await readKiloOpsSecret({ GF_SECRET_KEY: 'plain-value' }, 'GF_SECRET_KEY')).toBe(
      'plain-value'
    );
  });

  it('refuses a name the bundle does not serve without reading the legacy binding', async () => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, ['GF_SECRET_KEY']));
    const env = { GF_SECRET_KEY: store.secret, STS: sts.binding, SECRETS_SOURCE: 'sts' };

    await expect(readKiloOpsSecret(env, 'GF_SECRET_KEY')).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = { GF_SECRET_KEY: store.secret, SECRETS_SOURCE: 'sts' };

    await expect(readKiloOpsSecret(env, 'GF_SECRET_KEY')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readKiloOpsSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'GF_SECRET_KEY')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent', async () => {
    await expect(readKiloOpsSecret({}, 'GF_SECRET_KEY')).rejects.toThrow(
      /GF_SECRET_KEY is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding(
      okBundle({ O11Y_CF_AE_API_TOKEN: 'bundle-token', GF_SECRET_KEY: 'bundle-grafana' })
    );
    const env = { STS: sts.binding, SECRETS_SOURCE: 'sts' };

    expect(await readKiloOpsSecret(env, 'O11Y_CF_AE_API_TOKEN')).toBe('bundle-token');
    expect(await readKiloOpsSecret(env, 'GF_SECRET_KEY')).toBe('bundle-grafana');
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });
});
