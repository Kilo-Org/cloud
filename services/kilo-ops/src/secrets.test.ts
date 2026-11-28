import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import {
  readKiloOpsSecret,
  readSecretState,
  secretConfigured,
  secretsSource,
  type KiloOpsSecretName,
} from './secrets';

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

describe('secretConfigured', () => {
  it('is false where the deployment binds nothing for the name', () => {
    expect(secretConfigured({}, 'O11Y_CF_AE_API_TOKEN')).toBe(false);
    expect(
      secretConfigured({ GF_SECRET_KEY: storeSecret('grafana').secret }, 'O11Y_CF_AE_API_TOKEN')
    ).toBe(false);
  });

  it('is true for a store binding, a plain secret, and under sts', () => {
    // The env holds the *binding* that serves the name, not the name itself.
    expect(secretConfigured({ CF_ANALYTICS_API_KEY: 'plain' }, 'O11Y_CF_AE_API_TOKEN')).toBe(true);
    expect(
      secretConfigured(
        { CF_ANALYTICS_API_KEY: storeSecret('token').secret },
        'O11Y_CF_AE_API_TOKEN'
      )
    ).toBe(true);
    const sts = stsBinding();
    expect(
      secretConfigured({ STS: sts.binding, SECRETS_SOURCE: 'sts' }, 'O11Y_CF_AE_API_TOKEN')
    ).toBe(true);
    expect(sts.getBundle).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown source', () => {
    expect(() => secretConfigured({ SECRETS_SOURCE: 'infisical' }, 'GF_SECRET_KEY')).toThrow(
      /SECRETS_SOURCE/
    );
  });

  it('agrees with the read on the shape the dev block deploys', async () => {
    // The shape the `dev` block deploys: the Grafana key only, no Analytics Engine token.
    const dev = { GF_SECRET_KEY: storeSecret('grafana').secret };

    expect(secretConfigured(dev, 'O11Y_CF_AE_API_TOKEN')).toBe(false);
    await expect(readKiloOpsSecret(dev, 'O11Y_CF_AE_API_TOKEN')).rejects.toThrow(
      /CF_ANALYTICS_API_KEY is not configured/
    );
    expect(secretConfigured(dev, 'GF_SECRET_KEY')).toBe(true);
  });
});

describe('readSecretState', () => {
  it('reports off where the deployment binds no source, without reading', async () => {
    const dev = { GF_SECRET_KEY: storeSecret('grafana').secret };

    expect(await readSecretState(dev, 'O11Y_CF_AE_API_TOKEN')).toEqual({ state: 'off' });
  });

  it('returns the value a configured source serves', async () => {
    expect(
      await readSecretState({ CF_ANALYTICS_API_KEY: 'plain' }, 'O11Y_CF_AE_API_TOKEN')
    ).toEqual({ state: 'value', value: 'plain' });
  });

  it('reports a failed read, not off, when a configured source refuses', async () => {
    const failing = {
      get: async () => {
        throw new Error('store unavailable');
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await readSecretState({ GF_SECRET_KEY: failing }, 'GF_SECRET_KEY')).toEqual({
      state: 'failed',
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('fails closed on an unknown source instead of throwing at its caller', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await readSecretState({ SECRETS_SOURCE: 'infisical' }, 'GF_SECRET_KEY')).toEqual({
      state: 'failed',
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('reports a failed read, not off, when sts is selected without its binding', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await readSecretState({ SECRETS_SOURCE: 'sts' }, 'O11Y_CF_AE_API_TOKEN')).toEqual({
      state: 'failed',
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('logs a missing source in production and stays quiet in development', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await readSecretState({ ENVIRONMENT: 'production' }, 'O11Y_CF_AE_API_TOKEN')).toEqual({
      state: 'off',
    });
    expect(logged).toHaveBeenCalledOnce();

    logged.mockClear();
    expect(await readSecretState({ ENVIRONMENT: 'development' }, 'O11Y_CF_AE_API_TOKEN')).toEqual({
      state: 'off',
    });
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
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
