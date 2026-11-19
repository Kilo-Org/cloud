import { randomUUID } from 'node:crypto';

import type { platform_oauth_credentials } from '@kilocode/db/schema';
import {
  buildGitLabOAuthCredentialAad,
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  type GitLabOAuthSecretKind,
} from '@kilocode/worker-utils/gitlab-credential';

import { encryptKeyedEnvelope } from '../../../packages/encryption/src/keyed-envelope';

/** A year ahead: git-token-service refreshes a token near its expiry, and a refresh calls GitLab. */
const FAKE_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

function platformCredentialPublicKey(): { keyId: string; publicKeyPem: Buffer } {
  const keyId = process.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID?.trim();
  const publicKey = process.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY?.trim();
  if (!keyId || !publicKey) {
    throw new Error(
      'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID and _PUBLIC_KEY are missing from .env.local; run `pnpm dev:setup-env`'
    );
  }
  return { keyId, publicKeyPem: Buffer.from(publicKey, 'base64') };
}

/**
 * A personal GitLab OAuth credential row that the local git-token-service
 * resolves as `available`. It replicates the web app's encryption
 * (`apps/web/src/lib/integrations/platforms/gitlab/credential-encryption.ts`)
 * with the local platform-credential key from `.env.local`, so the worker
 * decrypts it with the matching private key.
 *
 * The tokens are placeholders, not GitLab tokens: a call to GitLab with them
 * fails. Use this row only for screens that read the connection status.
 */
export function fakeGitLabOAuthCredential(input: {
  integrationId: string;
  userId: string;
  providerBaseUrl: string;
  providerSubjectId: string;
  providerSubjectLogin: string;
}): typeof platform_oauth_credentials.$inferInsert {
  const key = platformCredentialPublicKey();
  const id = randomUUID();
  const credentialVersion = 1;
  const encrypt = (value: string, kind: GitLabOAuthSecretKind) =>
    encryptKeyedEnvelope(
      value,
      GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      key,
      buildGitLabOAuthCredentialAad({
        credentialId: id,
        integrationId: input.integrationId,
        providerBaseUrl: input.providerBaseUrl,
        owner: { type: 'user', id: input.userId },
        authorizedByUserId: input.userId,
        credentialVersion,
        kind,
      })
    );

  return {
    id,
    platform_integration_id: input.integrationId,
    authorized_by_user_id: input.userId,
    provider_subject_id: input.providerSubjectId,
    provider_subject_login: input.providerSubjectLogin,
    provider_base_url: input.providerBaseUrl,
    access_token_encrypted: encrypt('dev-seed-placeholder-access-token', 'access'),
    access_token_expires_at: new Date(Date.now() + FAKE_TOKEN_LIFETIME_MS).toISOString(),
    refresh_token_encrypted: encrypt('dev-seed-placeholder-refresh-token', 'refresh'),
    credential_version: credentialVersion,
  };
}
