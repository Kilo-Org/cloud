import { beforeEach, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';

const rsa = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ec = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_ID = 'slack-credential-key-v1';

const mockConfig: { keyset: string | undefined } = { keyset: undefined };

jest.mock('@/lib/config.server', () => ({
  get SLACK_CREDENTIAL_KEYSET_JSON() {
    return mockConfig.keyset;
  },
}));

import {
  SlackCredentialKeysetError,
  isSlackCredentialEncryptionConfigured,
  requireSlackCredentialKeyset,
  resetSlackCredentialKeysetCacheForTests,
} from './credential-keyset';

function validKeyset() {
  return {
    active: { keyId: KEY_ID, publicKeyPem: rsa.publicKey },
    decrypt: [{ keyId: KEY_ID, privateKeyPem: rsa.privateKey }],
  };
}

describe('Slack credential keyset', () => {
  beforeEach(() => {
    resetSlackCredentialKeysetCacheForTests();
    mockConfig.keyset = JSON.stringify(validKeyset());
  });

  it('accepts raw JSON', () => {
    expect(requireSlackCredentialKeyset().active.keyId).toBe(KEY_ID);
  });

  it('accepts base64-encoded JSON', () => {
    mockConfig.keyset = Buffer.from(JSON.stringify(validKeyset()), 'utf8').toString('base64');

    expect(requireSlackCredentialKeyset().active.keyId).toBe(KEY_ID);
  });

  it('exposes the active key ID as the only private-key slot lookup target', () => {
    const keyset = requireSlackCredentialKeyset();

    expect(keyset.privateKeys.active).toEqual({ keyId: KEY_ID });
    expect(keyset.privateKeys.decrypt).toEqual([{ keyId: KEY_ID, privateKeyPem: rsa.privateKey }]);
  });

  it('reports unconfigured rather than throwing from the probe', () => {
    mockConfig.keyset = undefined;

    expect(isSlackCredentialEncryptionConfigured()).toBe(false);
    expect(() => requireSlackCredentialKeyset()).toThrow(SlackCredentialKeysetError);
  });

  it.each([
    ['unparseable input', 'not json at all !!'],
    ['a missing active key', JSON.stringify({ decrypt: [] })],
  ])('rejects %s', (_label, raw) => {
    mockConfig.keyset = raw;

    expect(() => requireSlackCredentialKeyset()).toThrow(SlackCredentialKeysetError);
  });

  it('rejects private key material in the active public key', () => {
    mockConfig.keyset = JSON.stringify({
      active: { keyId: KEY_ID, publicKeyPem: rsa.privateKey },
      decrypt: [{ keyId: KEY_ID, privateKeyPem: rsa.privateKey }],
    });

    expect(() => requireSlackCredentialKeyset()).toThrow(SlackCredentialKeysetError);
  });

  it('rejects a non-RSA active key', () => {
    mockConfig.keyset = JSON.stringify({
      active: { keyId: KEY_ID, publicKeyPem: ec.publicKey },
      decrypt: [{ keyId: KEY_ID, privateKeyPem: rsa.privateKey }],
    });

    expect(() => requireSlackCredentialKeyset()).toThrow(SlackCredentialKeysetError);
  });

  it('rejects a keyset that can encrypt but not decrypt its own writes', () => {
    mockConfig.keyset = JSON.stringify({
      active: { keyId: KEY_ID, publicKeyPem: rsa.publicKey },
      decrypt: [{ keyId: 'some-older-key', privateKeyPem: rsa.privateKey }],
    });

    expect(() => requireSlackCredentialKeyset()).toThrow(SlackCredentialKeysetError);
  });

  it('memoizes so repeated calls do not re-validate', () => {
    const first = requireSlackCredentialKeyset();
    mockConfig.keyset = 'now invalid';

    expect(requireSlackCredentialKeyset()).toBe(first);
  });
});
