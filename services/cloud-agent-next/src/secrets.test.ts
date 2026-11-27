import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import {
  readCloudAgentNextSecret,
  readCloudAgentNextStoreSecret,
  secretsSource,
  type CloudAgentNextSecretName,
  type CloudAgentNextSecretsEnv,
} from './secrets';

const NAMES: CloudAgentNextSecretName[] = [
  'INTERNAL_API_SECRET',
  'NEXTAUTH_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_LITE_APP_PRIVATE_KEY',
  'AGENT_ENV_VARS_PRIVATE_KEY',
  'SSEC_KEY',
  'R2_SECRET_ACCESS_KEY',
  'R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY',
];
const ETAG = '"0123456789abcdef"';

type LegacyValue = string | { get(): Promise<string> };

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'cloud-agent-next',
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

/** One canonical name bound to a legacy value, plus the source and STS the reader consults. */
function legacyEnv(
  name: CloudAgentNextSecretName,
  value: LegacyValue,
  extra: { STS?: BundleBinding; SECRETS_SOURCE?: string } = {}
): CloudAgentNextSecretsEnv {
  const bindings: Partial<Record<CloudAgentNextSecretName, LegacyValue>> = {};
  bindings[name] = value;
  return { ...bindings, ...extra };
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

describe('readCloudAgentNextSecret', () => {
  it.each(NAMES)(
    'reads %s from its binding by default and from the bundle under sts',
    async name => {
      const store = storeSecret('legacy-value');
      const sts = stsBinding(okBundle({ [name]: 'bundle-value' }));
      const env = legacyEnv(name, store.secret, { STS: sts.binding });

      expect(await readCloudAgentNextSecret(env, name)).toBe('legacy-value');
      expect(sts.getBundle).not.toHaveBeenCalled();

      expect(await readCloudAgentNextSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe(
        'bundle-value'
      );
      expect(store.get).toHaveBeenCalledOnce();
      expect(sts.getBundle).toHaveBeenCalledOnce();

      // Flipping the variable back reads the legacy binding again.
      expect(
        await readCloudAgentNextSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name)
      ).toBe('legacy-value');
      expect(store.get).toHaveBeenCalledTimes(2);
      expect(sts.getBundle).toHaveBeenCalledOnce();
    }
  );

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(
      await readCloudAgentNextSecret({ INTERNAL_API_SECRET: 'plain-value' }, 'INTERNAL_API_SECRET')
    ).toBe('plain-value');
  });

  it('refuses a name the bundle does not serve without reading the legacy binding', async () => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, ['INTERNAL_API_SECRET']));
    const env = legacyEnv('INTERNAL_API_SECRET', store.secret, {
      STS: sts.binding,
      SECRETS_SOURCE: 'sts',
    });

    await expect(readCloudAgentNextSecret(env, 'INTERNAL_API_SECRET')).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = legacyEnv('INTERNAL_API_SECRET', store.secret, { SECRETS_SOURCE: 'sts' });

    await expect(readCloudAgentNextSecret(env, 'INTERNAL_API_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readCloudAgentNextSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'INTERNAL_API_SECRET')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent', async () => {
    await expect(readCloudAgentNextSecret({}, 'INTERNAL_API_SECRET')).rejects.toThrow(
      /INTERNAL_API_SECRET is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding(okBundle({ INTERNAL_API_SECRET: 'bundle-internal' }));
    const env = legacyEnv('INTERNAL_API_SECRET', 'legacy-value', {
      STS: sts.binding,
      SECRETS_SOURCE: 'sts',
    });

    expect(await readCloudAgentNextSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(await readCloudAgentNextSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });
});

describe('readCloudAgentNextStoreSecret', () => {
  it('reads the Secrets Store copy, never the plain inbound Worker secret', async () => {
    const inbound = storeSecret('inbound-value');
    const store = storeSecret('outbound-value');
    const env: CloudAgentNextSecretsEnv = {
      INTERNAL_API_SECRET: inbound.secret,
      INTERNAL_API_SECRET_PROD: store.secret,
    };

    expect(await readCloudAgentNextSecret(env, 'INTERNAL_API_SECRET')).toBe('inbound-value');
    expect(await readCloudAgentNextStoreSecret(env, 'INTERNAL_API_SECRET')).toBe('outbound-value');
    expect(inbound.get).toHaveBeenCalledOnce();
    expect(store.get).toHaveBeenCalledOnce();
  });

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(
      await readCloudAgentNextStoreSecret(
        { INTERNAL_API_SECRET_PROD: 'plain-store-value' },
        'INTERNAL_API_SECRET'
      )
    ).toBe('plain-store-value');
  });

  it('reads the same bundle key as the plain family under sts', async () => {
    const sts = stsBinding(okBundle({ INTERNAL_API_SECRET: 'bundle-internal' }));
    const inbound = storeSecret('inbound-value');
    const store = storeSecret('outbound-value');
    const env: CloudAgentNextSecretsEnv = {
      INTERNAL_API_SECRET: inbound.secret,
      INTERNAL_API_SECRET_PROD: store.secret,
      STS: sts.binding,
      SECRETS_SOURCE: 'sts',
    };

    expect(await readCloudAgentNextSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(await readCloudAgentNextStoreSecret(env, 'INTERNAL_API_SECRET')).toBe('bundle-internal');
    expect(inbound.get).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });

  it('fails closed when the store binding or the STS binding is absent', async () => {
    await expect(
      readCloudAgentNextStoreSecret({ INTERNAL_API_SECRET: 'inbound-value' }, 'INTERNAL_API_SECRET')
    ).rejects.toThrow(/INTERNAL_API_SECRET_PROD is not configured/);

    const store = storeSecret('outbound-value');
    const stsless: CloudAgentNextSecretsEnv = {
      INTERNAL_API_SECRET_PROD: store.secret,
      SECRETS_SOURCE: 'sts',
    };
    await expect(readCloudAgentNextStoreSecret(stsless, 'INTERNAL_API_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    expect(store.get).not.toHaveBeenCalled();
  });
});
