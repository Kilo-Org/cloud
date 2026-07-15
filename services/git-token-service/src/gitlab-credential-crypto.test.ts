import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabPersonalAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import { describe, expect, it } from 'vitest';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';

function keyConfiguration() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    keyId: 'active',
    publicKey,
    privateKey,
    env: {
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: 'active',
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    },
  };
}

describe('GitLabCredentialCrypto', () => {
  it('returns only the active key ID and derived public-key fingerprint for audit preflight', async () => {
    const keys = keyConfiguration();
    const expectedFingerprint = createHash('sha256')
      .update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' }))
      .digest('hex');

    const result = await new GitLabCredentialCrypto(keys.env).auditKeyIdentity();

    expect(result).toEqual({
      status: 'available',
      keyId: 'active',
      publicKeySha256: expectedFingerprint,
    });
    expect(JSON.stringify(result)).not.toContain('BEGIN');
    expect(JSON.stringify(result)).not.toContain(Buffer.from(keys.privateKey).toString('base64'));
  });

  it('does not expose an identity when public and private audit keys do not match', async () => {
    const keys = keyConfiguration();
    const differentKeys = keyConfiguration();

    await expect(
      new GitLabCredentialCrypto({
        ...keys.env,
        BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY:
          differentKeys.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY,
      }).auditKeyIdentity()
    ).resolves.toEqual({ status: 'configuration_error' });
  });

  it('decrypts a GitLab PAT with the deployed platform credential keypair', async () => {
    const keys = keyConfiguration();
    const aad = buildGitLabPersonalAccessTokenAad({
      credentialId: 'credential-1',
      integrationId: 'integration-1',
      providerBaseUrl: 'https://gitlab.example.com',
      owner: { type: 'user', id: 'user-1' },
      authorizedByUserId: 'user-1',
      credentialVersion: 1,
    });
    const ciphertext = encryptKeyedEnvelope(
      'glpat-secret',
      GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      { keyId: keys.keyId, publicKeyPem: keys.publicKey },
      aad
    );

    await expect(
      new GitLabCredentialCrypto(keys.env).decrypt({
        ciphertext,
        scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        aad,
      })
    ).resolves.toEqual({ status: 'available', token: 'glpat-secret' });
  });

  it('encrypts a refreshed GitLab token for the active platform credential key', async () => {
    const keys = keyConfiguration();
    const aad = buildGitLabPersonalAccessTokenAad({
      credentialId: 'credential-1',
      integrationId: 'integration-1',
      providerBaseUrl: 'https://gitlab.example.com',
      owner: { type: 'user', id: 'user-1' },
      authorizedByUserId: 'user-1',
      credentialVersion: 2,
    });
    const crypto = new GitLabCredentialCrypto(keys.env);

    const encrypted = await crypto.encrypt({
      plaintext: 'refreshed-secret',
      scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      aad,
    });
    expect(encrypted.status).toBe('available');
    if (encrypted.status !== 'available') throw new Error('expected encrypted credential');
    await expect(
      crypto.decrypt({
        ciphertext: encrypted.ciphertext,
        scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        aad,
      })
    ).resolves.toEqual({ status: 'available', token: 'refreshed-secret' });
  });

  it('classifies audit failures without returning persisted ciphertext', async () => {
    const keys = keyConfiguration();
    const crypto = new GitLabCredentialCrypto(keys.env);

    await expect(
      crypto.auditDecrypt({
        ciphertext: '{',
        scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        aad: 'expected-aad',
      })
    ).resolves.toEqual({ status: 'invalid_envelope' });

    const encrypted = await crypto.encrypt({
      plaintext: 'secret-value',
      scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      aad: 'original-aad',
    });
    expect(encrypted.status).toBe('available');
    if (encrypted.status !== 'available') throw new Error('expected encrypted credential');
    await expect(
      crypto.auditDecrypt({
        ciphertext: encrypted.ciphertext,
        scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        aad: 'different-aad',
      })
    ).resolves.toEqual({ status: 'decrypt_failed' });
  });
});
