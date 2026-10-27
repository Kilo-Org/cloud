import { generateKeyPairSync } from 'node:crypto';

const KEY_ID = 'slack-credential-test-key';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/**
 * Envelope keyset for tests that run the real Slack credential store.
 *
 * Test-only material, generated per test module registry. Use it where a test
 * must exercise the install path end to end instead of mocking the store.
 */
export const TEST_SLACK_CREDENTIAL_KEYSET_JSON = JSON.stringify({
  active: { keyId: KEY_ID, publicKeyPem: publicKey },
  decrypt: [{ keyId: KEY_ID, privateKeyPem: privateKey }],
});
