import { beforeEach, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME } from '@kilocode/worker-utils/slack-credential';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_KEY_ID = 'slack-credential-key-v1';

const mockConfig: { keyset: string | undefined } = {
  keyset: JSON.stringify({
    active: { keyId: TEST_KEY_ID, publicKeyPem: testKeyPair.publicKey },
    decrypt: [{ keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey }],
  }),
};

jest.mock('@/lib/config.server', () => ({
  get SLACK_CREDENTIAL_KEYSET_JSON() {
    return mockConfig.keyset;
  },
}));

import {
  SlackCredentialDecryptionError,
  decryptSlackCredentialSecret,
  encryptSlackCredentialSecret,
  type SlackCredentialIdentity,
} from './credential-encryption';
import { resetSlackCredentialKeysetCacheForTests } from './credential-keyset';

const identity: SlackCredentialIdentity = {
  credentialId: 'credential-1',
  integrationId: 'integration-1',
  slackTeamId: 'T00000001',
  owner: { type: 'org', id: 'organization-1' },
  credentialVersion: 1,
};

const BOT_TOKEN = 'xoxb-not-a-real-token';

describe('Slack credential encryption', () => {
  beforeEach(() => {
    resetSlackCredentialKeysetCacheForTests();
  });

  it('round-trips a secret and does not leak the plaintext into the envelope', () => {
    const ciphertext = encryptSlackCredentialSecret(BOT_TOKEN, identity, 'access');

    expect(ciphertext).not.toContain(BOT_TOKEN);
    expect(JSON.parse(ciphertext)).toMatchObject({
      scheme: SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      version: 1,
      keyId: TEST_KEY_ID,
    });
    expect(decryptSlackCredentialSecret(ciphertext, identity, 'access')).toBe(BOT_TOKEN);
  });

  it('binds the ciphertext to the secret kind', () => {
    const ciphertext = encryptSlackCredentialSecret(BOT_TOKEN, identity, 'access');

    expect(() => decryptSlackCredentialSecret(ciphertext, identity, 'refresh')).toThrow(
      SlackCredentialDecryptionError
    );
  });

  // Each case is a way an attacker with database rows could try to reuse ciphertext.
  it.each([
    ['a different credential row', { credentialId: 'credential-2' }],
    ['a different integration', { integrationId: 'integration-2' }],
    ['a different Slack workspace', { slackTeamId: 'T00000002' }],
    ['a different owner id', { owner: { type: 'org', id: 'organization-2' } as const }],
    ['a different owner type', { owner: { type: 'user', id: 'organization-1' } as const }],
    ['a bumped credential version', { credentialVersion: 2 }],
  ])('refuses to decrypt under %s', (_label, override) => {
    const ciphertext = encryptSlackCredentialSecret(BOT_TOKEN, identity, 'access');

    expect(() =>
      decryptSlackCredentialSecret(ciphertext, { ...identity, ...override }, 'access')
    ).toThrow(SlackCredentialDecryptionError);
  });

  it('does not include the underlying error message in the thrown error', () => {
    const ciphertext = encryptSlackCredentialSecret(BOT_TOKEN, identity, 'access');

    try {
      decryptSlackCredentialSecret(ciphertext, { ...identity, credentialVersion: 2 }, 'access');
      throw new Error('Expected decryption to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SlackCredentialDecryptionError);
      expect((error as SlackCredentialDecryptionError).message).toBe(
        'Failed to decrypt Slack access token'
      );
      expect((error as SlackCredentialDecryptionError).kind).toBe('access');
    }
  });

  it('rejects an envelope written under a different scheme', () => {
    const ciphertext = encryptSlackCredentialSecret(BOT_TOKEN, identity, 'access');
    const foreign = JSON.stringify({ ...JSON.parse(ciphertext), scheme: 'some-other-scheme' });

    expect(() => decryptSlackCredentialSecret(foreign, identity, 'access')).toThrow(
      SlackCredentialDecryptionError
    );
  });
});
