import { describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import {
  readGitTokenServiceSecret,
  secretsSource,
  type GitTokenServiceSecretName,
  type GitTokenServiceSecretsEnv,
} from './secrets';

const NAMES: GitTokenServiceSecretName[] = [
  'NEXTAUTH_SECRET',
  'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY',
  'BITBUCKET_CLIENT_ID',
  'BITBUCKET_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_LITE_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_SECRET',
  'GITLAB_CLIENT_SECRET',
  'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY',
  'USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY',
];
/** The binding each bundle name reads today, repeated so a loop can place it in the env. */
const BINDING: Record<GitTokenServiceSecretName, string> = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET',
  SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: 'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY',
  BITBUCKET_CLIENT_ID: 'BITBUCKET_CLIENT_ID',
  BITBUCKET_CLIENT_SECRET: 'BITBUCKET_CLIENT_SECRET',
  GITHUB_APP_PRIVATE_KEY: 'GITHUB_APP_PRIVATE_KEY',
  GITHUB_LITE_APP_PRIVATE_KEY: 'GITHUB_LITE_APP_PRIVATE_KEY',
  GITHUB_APP_CLIENT_SECRET: 'GITHUB_APP_CLIENT_SECRET',
  GITLAB_CLIENT_SECRET: 'GITLAB_CLIENT_SECRET',
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: 'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY',
  USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY: 'USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY',
};
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, string>, missing: string[] = []) {
  return {
    status: 'ok' as const,
    workload: 'git-token-service',
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
function stsBinding(bundle = okBundle({ NEXTAUTH_SECRET: 'bundle-nexauth' })) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => bundle);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get }, get };
}

/** Places the legacy binding under the name this Worker reads today. */
function legacyEnv(
  name: GitTokenServiceSecretName,
  secret: { get(): Promise<string> }
): GitTokenServiceSecretsEnv {
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

describe('readGitTokenServiceSecret', () => {
  it.each(NAMES)(
    'reads %s from its binding by default and from the bundle under sts',
    async name => {
      const store = storeSecret('legacy-value');
      const sts = stsBinding(okBundle({ [name]: 'bundle-value' }));
      const env = { ...legacyEnv(name, store.secret), STS: sts.binding };

      expect(await readGitTokenServiceSecret(env, name)).toBe('legacy-value');
      expect(sts.getBundle).not.toHaveBeenCalled();

      expect(await readGitTokenServiceSecret({ ...env, SECRETS_SOURCE: 'sts' }, name)).toBe(
        'bundle-value'
      );
      expect(store.get).toHaveBeenCalledOnce();
      expect(sts.getBundle).toHaveBeenCalledOnce();

      // Flipping the variable back reads the legacy binding again.
      expect(
        await readGitTokenServiceSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name)
      ).toBe('legacy-value');
      expect(store.get).toHaveBeenCalledTimes(2);
      expect(sts.getBundle).toHaveBeenCalledOnce();
    }
  );

  it('reads a plain Worker secret, which arrives as a string', async () => {
    expect(
      await readGitTokenServiceSecret({ NEXTAUTH_SECRET: 'plain-value' }, 'NEXTAUTH_SECRET')
    ).toBe('plain-value');
  });

  it('refuses a name the bundle does not serve without reading the legacy binding', async () => {
    const store = storeSecret('legacy-value');
    const sts = stsBinding(okBundle({}, ['NEXTAUTH_SECRET']));
    const env = {
      ...legacyEnv('NEXTAUTH_SECRET', store.secret),
      STS: sts.binding,
      SECRETS_SOURCE: 'sts',
    };

    await expect(readGitTokenServiceSecret(env, 'NEXTAUTH_SECRET')).rejects.toBeInstanceOf(
      SecretUnavailableError
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const store = storeSecret('legacy-value');
    const env = { ...legacyEnv('NEXTAUTH_SECRET', store.secret), SECRETS_SOURCE: 'sts' };

    await expect(readGitTokenServiceSecret(env, 'NEXTAUTH_SECRET')).rejects.toThrow(
      /STS service binding is missing/
    );
    await expect(
      readGitTokenServiceSecret({ ...env, SECRETS_SOURCE: 'infisical' }, 'NEXTAUTH_SECRET')
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy binding is absent', async () => {
    await expect(readGitTokenServiceSecret({}, 'NEXTAUTH_SECRET')).rejects.toThrow(
      /NEXTAUTH_SECRET is not configured/
    );
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const sts = stsBinding(okBundle({ NEXTAUTH_SECRET: 'bundle-nexauth' }));
    const env = { STS: sts.binding, SECRETS_SOURCE: 'sts' };

    expect(await readGitTokenServiceSecret(env, 'NEXTAUTH_SECRET')).toBe('bundle-nexauth');
    expect(await readGitTokenServiceSecret(env, 'NEXTAUTH_SECRET')).toBe('bundle-nexauth');
    expect(sts.getBundle).toHaveBeenCalledOnce();
  });
});
