import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';

import {
  LOCAL_ENVELOPE_KEY_SPECS,
  generateEnvelopeKeypair,
  planEnvelopeProvisioning,
} from './envelope-keys';

const GITHUB_SPEC = LOCAL_ENVELOPE_KEY_SPECS.find(
  spec => spec.keyIdEnv === 'USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID'
);

function requireGitHubSpec() {
  assert.ok(GITHUB_SPEC, 'expected the GitHub user-token envelope spec');
  return GITHUB_SPEC;
}

test('generates a base64 SPKI/PKCS#8 keypair the envelopes can use', () => {
  const pair = generateEnvelopeKeypair();

  // Both halves are base64-encoded PEM: the web app and the Worker decode the
  // value before handing it to the crypto layer, so a raw PEM would fail there.
  const publicPem = Buffer.from(pair.publicKey, 'base64').toString('utf8');
  const privatePem = Buffer.from(pair.privateKey, 'base64').toString('utf8');
  assert.match(publicPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.match(privatePem, /^-----BEGIN PRIVATE KEY-----/);

  const publicKey = createPublicKey(publicPem);
  const privateKey = createPrivateKey(privatePem);
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
  assert.equal(publicKey.asymmetricKeyDetails?.modulusLength, 4096);
  // A public/private mismatch would only surface as a runtime decryption error
  // in git-token-service, so compare the derived public halves here.
  assert.equal(
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
    publicKey.export({ type: 'spki', format: 'pem' }).toString()
  );
});

test('generates a stable key ID when the envelope is unconfigured', () => {
  const spec = requireGitHubSpec();

  const provisioning = planEnvelopeProvisioning(spec, () => '');

  assert.equal(provisioning.status, 'generate');
  if (provisioning.status !== 'generate') return;
  assert.equal(provisioning.keypair.keyId, 'github-user-token-local-v1');
  const publicKey = createPublicKey(
    Buffer.from(provisioning.keypair.publicKey, 'base64').toString('utf8')
  );
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
});

test('keeps a configured envelope so stored credentials still decrypt', () => {
  const spec = requireGitHubSpec();
  const configured = new Map([
    [spec.keyIdEnv, 'github-user-token-dev-v1'],
    [spec.publicKeyEnv, 'existing-public-key'],
    [spec.privateKeyEnv, 'existing-private-key'],
  ]);

  // A regenerated pair could not decrypt what git-token-service already holds.
  assert.deepEqual(
    planEnvelopeProvisioning(spec, key => configured.get(key)),
    {
      status: 'keep',
      keypair: {
        keyId: 'github-user-token-dev-v1',
        publicKey: 'existing-public-key',
        privateKey: 'existing-private-key',
      },
    }
  );
});

test('keeps the values of a half-configured envelope instead of dropping them', () => {
  const spec = requireGitHubSpec();

  for (const partial of [
    new Map([[spec.keyIdEnv, 'github-user-token-dev-v1']]),
    new Map([[spec.publicKeyEnv, 'existing-public-key']]),
    new Map([[spec.privateKeyEnv, 'existing-private-key']]),
    new Map([
      [spec.keyIdEnv, 'github-user-token-dev-v1'],
      [spec.publicKeyEnv, 'existing-public-key'],
    ]),
  ]) {
    // The write path rebuilds .env.local from the example, so a pair that is not
    // carried into the result is erased rather than left alone.
    assert.deepEqual(
      planEnvelopeProvisioning(spec, key => partial.get(key)),
      {
        status: 'incomplete',
        configured: partial.size,
        keypair: {
          keyId: partial.get(spec.keyIdEnv) ?? '',
          publicKey: partial.get(spec.publicKeyEnv) ?? '',
          privateKey: partial.get(spec.privateKeyEnv) ?? '',
        },
      }
    );
  }
});
