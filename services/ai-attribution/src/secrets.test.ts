import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import { readAiAttributionSecret, secretsSource, type AiAttributionSecretName } from './secrets';

const NAMES: AiAttributionSecretName[] = ['NEXTAUTH_SECRET', 'ADMIN_SECRET'];
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'kilo-ai-attribution',
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
function stsBinding(
  bundle = okBundle({
    NEXTAUTH_SECRET: 'bundle-nextauth',
    ADMIN_SECRET: 'bundle-admin',
  })
) {
  const getBundle = jest.fn(async () => bundle);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = jest.fn(async () => value);
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

describe('readAiAttributionSecret', () => {
  it.each(NAMES)('reads %s from the binding by default and the bundle under sts', async name => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({ [name]: 'bundle-value' }));
    const env = { NEXTAUTH_SECRET: store.secret, ADMIN_SECRET: store.secret, STS: sts.binding };

    expect(await readAiAttributionSecret(env, name)).toBe('legacy-value');
    expect(sts.getBundle).not.toHaveBeenCalled();

    expect(await readAiAttributionSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe(
      'bundle-value'
    );
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(sts.getBundle).toHaveBeenCalledTimes(1);

    // Flipping the variable back reads the legacy binding again.
    expect(await readAiAttributionSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name)).toBe(
      'legacy-value'
    );
    expect(store.get).toHaveBeenCalledTimes(2);
    expect(sts.getBundle).toHaveBeenCalledTimes(1);
  });

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(await readAiAttributionSecret({ ADMIN_SECRET: 'plain-value' }, 'ADMIN_SECRET')).toBe(
      'plain-value'
    );
  });

  it('refuses a name the bundle does not serve without reading the legacy binding', async () => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, ['ADMIN_SECRET']));
    const env = { ADMIN_SECRET: store.secret, STS: sts.binding, SECRETS_SOURCE: 'sts' };

    await expect(readAiAttributionSecret(env, 'ADMIN_SECRET')).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = { ADMIN_SECRET: store.secret, SECRETS_SOURCE: 'sts' };

    await expect(readAiAttributionSecret(env, 'ADMIN_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readAiAttributionSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'ADMIN_SECRET')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent', async () => {
    await expect(readAiAttributionSecret({}, 'NEXTAUTH_SECRET')).rejects.toThrow(
      /NEXTAUTH_SECRET is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: 'bundle-nextauth' }));
    const env = { STS: sts.binding, SECRETS_SOURCE: 'sts' };

    expect(await readAiAttributionSecret(env, 'NEXTAUTH_SECRET')).toBe('bundle-nextauth');
    expect(await readAiAttributionSecret(env, 'NEXTAUTH_SECRET')).toBe('bundle-nextauth');
    expect(sts.getBundle).toHaveBeenCalledTimes(1);
  });
});
