import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { encryptWithPublicKey } from '../../utils/encryption.js';
import { buildFrameEnv } from './frame-env.js';

let publicKey: string;
let privateKey: string;

beforeAll(() => {
  ({ publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }));
});

function secret(value: string) {
  return encryptWithPublicKey(value, publicKey);
}

describe('buildFrameEnv', () => {
  it('returns the same env and no secret keys when there are no secrets', () => {
    const specEnv = { PLAIN: 'value', KILOCODE_TOKEN: 'grant-token' };
    const result = buildFrameEnv({ specEnv, encryptedSecrets: undefined, privateKey });
    expect(result.env).toEqual(specEnv);
    expect(result.secretEnvKeys).toEqual([]);
  });

  it('overlays a secret over plaintext of the same key', () => {
    const result = buildFrameEnv({
      specEnv: { DATABASE_URL: 'plaintext', KEEP: 'kept' },
      encryptedSecrets: { DATABASE_URL: secret('encrypted-value') },
      privateKey,
    });
    expect(result.env).toEqual({ DATABASE_URL: 'encrypted-value', KEEP: 'kept' });
    expect(result.secretEnvKeys).toEqual(['DATABASE_URL']);
  });

  it.each([
    'KILOCODE_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'GLAB_IS_OAUTH2',
    'GITLAB_HOST',
    'GITLAB_SUBFOLDER',
    'BITBUCKET_TOKEN',
    'KILO_BITBUCKET_WORKSPACE_SLUG',
    'KILO_BITBUCKET_REPOSITORY_SLUG',
    'KILO_BITBUCKET_WORKSPACE_UUID',
    'KILO_BITBUCKET_REPOSITORY_UUID',
  ])('restores the issued %s the spec already carried over a same-named secret', key => {
    const result = buildFrameEnv({
      specEnv: { [key]: 'grant-value' },
      encryptedSecrets: { [key]: secret('secret-value') },
      privateKey,
    });
    expect(result.env?.[key]).toBe('grant-value');
    // The grant value survived, not the decrypted secret, so nothing to redact.
    expect(result.secretEnvKeys).toEqual([]);
  });

  it('keeps a plaintext GH_TOKEN the grant left in place when a different secret overlays', () => {
    const result = buildFrameEnv({
      specEnv: { GH_TOKEN: 'grant-gh', GITHUB_TOKEN: 'grant-gh' },
      encryptedSecrets: { DATABASE_URL: secret('db') },
      privateKey,
    });
    expect(result.env?.GH_TOKEN).toBe('grant-gh');
    expect(result.env?.GITHUB_TOKEN).toBe('grant-gh');
    expect(result.secretEnvKeys).toEqual(['DATABASE_URL']);
  });

  it('deletes an org id a secret added when the uncontained spec did not carry it', () => {
    const result = buildFrameEnv({
      specEnv: {},
      encryptedSecrets: { KILOCODE_ORGANIZATION_ID: secret('org-from-secret') },
      privateKey,
    });
    expect(Object.hasOwn(result.env ?? {}, 'KILOCODE_ORGANIZATION_ID')).toBe(false);
    expect(result.secretEnvKeys).toEqual([]);
  });

  it('keeps a contained spec org id, including a value the grant did not touch', () => {
    const result = buildFrameEnv({
      specEnv: { KILOCODE_ORGANIZATION_ID: 'org-from-grant' },
      encryptedSecrets: { KILOCODE_ORGANIZATION_ID: secret('org-from-secret') },
      privateKey,
    });
    expect(result.env?.KILOCODE_ORGANIZATION_ID).toBe('org-from-grant');
  });

  it('deletes a control-runtime name a secret added when the spec did not carry it', () => {
    const result = buildFrameEnv({
      specEnv: {},
      encryptedSecrets: { SANDBOX_CONTROL_CREDENTIAL: secret('forged') },
      privateKey,
    });
    expect(Object.hasOwn(result.env ?? {}, 'SANDBOX_CONTROL_CREDENTIAL')).toBe(false);
    expect(result.secretEnvKeys).toEqual([]);
  });

  it('keeps a secret name the grant did not issue and the spec did not carry', () => {
    const result = buildFrameEnv({
      specEnv: {},
      encryptedSecrets: { GH_TOKEN: secret('user-gh') },
      privateKey,
    });
    expect(result.env?.GH_TOKEN).toBe('user-gh');
  });

  it('throws when secrets are present and no private key is configured', () => {
    expect(() =>
      buildFrameEnv({
        specEnv: {},
        encryptedSecrets: { DATABASE_URL: secret('value') },
        privateKey: undefined,
      })
    ).toThrow(/Private key is required/);
  });
});
