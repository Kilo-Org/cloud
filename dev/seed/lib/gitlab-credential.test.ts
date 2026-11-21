import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGitLabOAuthCredentialAad,
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  type GitLabOAuthSecretKind,
} from '@kilocode/worker-utils/gitlab-credential';

import { decryptKeyedEnvelope } from '../../../packages/encryption/src/keyed-envelope';
import { generateEnvelopeKeypair } from '../../local/envelope-keys';
import { fakeGitLabOAuthCredential } from './gitlab-credential';

const KEY_ID = 'platform-credential-local-v1';
const USER_ID = 'dev-seed:user';
const INTEGRATION_ID = '7a0c7d1c-46a4-4b0c-9a8e-6d5f2b0e8c11';

void test('stores tokens git-token-service decrypts under the row it names', () => {
  const keypair = generateEnvelopeKeypair();
  process.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID = KEY_ID;
  process.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY = keypair.publicKey;

  const row = fakeGitLabOAuthCredential({
    integrationId: INTEGRATION_ID,
    userId: USER_ID,
    providerBaseUrl: 'https://gitlab.com',
    providerSubjectId: 'dev-seed-gitlab-account',
    providerSubjectLogin: 'manual-review-lab',
  });

  // The worker rebuilds the associated data from the stored row and decrypts
  // with the private half; a mismatch in any bound field reads as unreadable.
  const decrypt = (ciphertext: string | null | undefined, kind: GitLabOAuthSecretKind) => {
    assert.ok(row.id && ciphertext);
    return decryptKeyedEnvelope(
      ciphertext,
      GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      { active: { keyId: KEY_ID, privateKeyPem: Buffer.from(keypair.privateKey, 'base64') } },
      buildGitLabOAuthCredentialAad({
        credentialId: row.id,
        integrationId: row.platform_integration_id,
        providerBaseUrl: 'https://gitlab.com',
        owner: { type: 'user', id: USER_ID },
        authorizedByUserId: USER_ID,
        credentialVersion: 1,
        kind,
      })
    );
  };
  assert.equal(decrypt(row.access_token_encrypted, 'access'), 'dev-seed-placeholder-access-token');
  assert.equal(
    decrypt(row.refresh_token_encrypted, 'refresh'),
    'dev-seed-placeholder-refresh-token'
  );

  // A token near its expiry makes the worker refresh it at GitLab first.
  assert.ok(row.access_token_expires_at);
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  assert.ok(new Date(row.access_token_expires_at).getTime() > Date.now() + thirtyDays);
});
