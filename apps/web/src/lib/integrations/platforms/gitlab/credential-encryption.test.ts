import { beforeEach, describe, expect, it } from '@jest/globals';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import {
  encryptGitLabOAuthCredentials,
  encryptGitLabPersonalAccessToken,
  encryptGitLabProjectAccessToken,
  getGitLabCredentialEncryptionPublicKeyInfo,
} from './credential-encryption';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const nonRsaPublicKey = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;
const TEST_KEY_ID = 'platform-credential-key-v1';
const mockCredentialEncryptionConfig: {
  keyId: string | undefined;
  publicKey: string | undefined;
} = {
  keyId: TEST_KEY_ID,
  publicKey: Buffer.from(testKeyPair.publicKey).toString('base64'),
};

jest.mock('@/lib/config.server', () => ({
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID() {
    return mockCredentialEncryptionConfig.keyId;
  },
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY() {
    return mockCredentialEncryptionConfig.publicKey;
  },
}));

const oauthContext = {
  credentialId: 'credential-1',
  integrationId: 'integration-1',
  providerBaseUrl: 'https://gitlab.example.com/root',
  owner: { type: 'org', id: 'organization-1' } as const,
  authorizedByUserId: 'user-1',
  credentialVersion: 1,
};

describe('GitLab credential encryption', () => {
  beforeEach(() => {
    mockCredentialEncryptionConfig.keyId = TEST_KEY_ID;
    mockCredentialEncryptionConfig.publicKey = Buffer.from(testKeyPair.publicKey).toString(
      'base64'
    );
  });

  it('encrypts every OAuth secret kind with its bound AAD', () => {
    const plaintext = {
      accessToken: 'gitlab-access-token',
      refreshToken: 'gitlab-refresh-token',
      oauthClientSecret: 'self-hosted-client-secret',
    };

    const encrypted = encryptGitLabOAuthCredentials({ ...oauthContext, ...plaintext });
    const privateKeys = {
      active: {
        keyId: TEST_KEY_ID,
        privateKeyPem: testKeyPair.privateKey,
      },
    };
    const decrypt = (ciphertext: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
      decryptKeyedEnvelope(
        ciphertext,
        GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        privateKeys,
        buildGitLabOAuthCredentialAad({ ...oauthContext, kind })
      );

    expect(decrypt(encrypted.accessTokenEncrypted, 'access')).toBe(plaintext.accessToken);
    expect(decrypt(encrypted.refreshTokenEncrypted, 'refresh')).toBe(plaintext.refreshToken);
    if (!encrypted.oauthClientSecretEncrypted) {
      throw new Error('Expected encrypted custom client secret');
    }
    expect(decrypt(encrypted.oauthClientSecretEncrypted, 'oauth-client-secret')).toBe(
      plaintext.oauthClientSecret
    );
    expect(JSON.stringify(encrypted)).not.toContain(plaintext.accessToken);
    expect(JSON.stringify(encrypted)).not.toContain(plaintext.refreshToken);
    expect(JSON.stringify(encrypted)).not.toContain(plaintext.oauthClientSecret);
  });

  it('reports only the configured key ID and canonical public-key fingerprint', () => {
    const publicKeyDer = createPublicKey(testKeyPair.publicKey).export({
      type: 'spki',
      format: 'der',
    });

    expect(getGitLabCredentialEncryptionPublicKeyInfo()).toEqual({
      keyId: TEST_KEY_ID,
      publicKeySha256: createHash('sha256').update(publicKeyDer).digest('hex'),
    });
  });

  it('leaves the optional custom client-secret ciphertext null when none is supplied', () => {
    const encrypted = encryptGitLabOAuthCredentials({
      ...oauthContext,
      accessToken: 'gitlab-access-token',
      refreshToken: 'gitlab-refresh-token',
      oauthClientSecret: null,
    });

    expect(encrypted.oauthClientSecretEncrypted).toBeNull();
    expect(encrypted.accessTokenEncrypted).toEqual(expect.any(String));
    expect(encrypted.refreshTokenEncrypted).toEqual(expect.any(String));
  });

  it('encrypts a personal access token with supplier-bound AAD', () => {
    const input = {
      credentialId: 'credential-2',
      integrationId: 'integration-2',
      providerBaseUrl: 'https://gitlab.example.com',
      owner: { type: 'user', id: 'user-2' } as const,
      authorizedByUserId: 'user-2',
      credentialVersion: 3,
      token: 'glpat-secret-value-123',
    };

    const encrypted = encryptGitLabPersonalAccessToken(input);

    expect(
      decryptKeyedEnvelope(
        encrypted,
        GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        {
          active: {
            keyId: TEST_KEY_ID,
            privateKeyPem: testKeyPair.privateKey,
          },
        },
        buildGitLabPersonalAccessTokenAad(input)
      )
    ).toBe(input.token);
    expect(encrypted).not.toContain(input.token);
  });

  it('encrypts a project access token with resource-bound AAD', () => {
    const input = {
      credentialId: 'credential-3',
      integrationId: 'integration-3',
      providerBaseUrl: 'https://gitlab.example.com/root',
      owner: { type: 'org', id: 'organization-3' } as const,
      providerResourceId: '42',
      credentialVersion: 2,
      token: 'glpat-project-secret-456',
    };

    const encrypted = encryptGitLabProjectAccessToken(input);

    expect(
      decryptKeyedEnvelope(
        encrypted,
        GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        {
          active: {
            keyId: TEST_KEY_ID,
            privateKeyPem: testKeyPair.privateKey,
          },
        },
        buildGitLabProjectAccessTokenAad(input)
      )
    ).toBe(input.token);
    expect(encrypted).not.toContain(input.token);
  });

  it.each([
    ['missing key ID', undefined, Buffer.from(testKeyPair.publicKey).toString('base64')],
    ['whitespace key ID', ' key-v1 ', Buffer.from(testKeyPair.publicKey).toString('base64')],
    ['missing public key', 'key-v1', undefined],
    ['malformed public key', 'key-v1', Buffer.from('not a public key').toString('base64')],
    ['private key material', 'key-v1', Buffer.from(testKeyPair.privateKey).toString('base64')],
    ['non-RSA public key', 'key-v1', Buffer.from(nonRsaPublicKey).toString('base64')],
  ])('rejects %s before producing ciphertext', (_label, keyId, publicKey) => {
    mockCredentialEncryptionConfig.keyId = keyId;
    mockCredentialEncryptionConfig.publicKey = publicKey;

    expect(() =>
      encryptGitLabPersonalAccessToken({
        credentialId: 'credential-invalid',
        integrationId: 'integration-invalid',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: { type: 'user', id: 'user-invalid' },
        authorizedByUserId: 'user-invalid',
        credentialVersion: 1,
        token: 'must-not-be-encrypted',
      })
    ).toThrow('GitLab credential encryption is not configured');
  });
});
