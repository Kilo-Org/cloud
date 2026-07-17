import 'server-only';

import { createHash, createPublicKey } from 'node:crypto';
import {
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID,
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY,
} from '@/lib/config.server';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
  type GitLabOAuthCredentialAadInput,
  type GitLabPersonalAccessTokenAadInput,
  type GitLabProjectAccessTokenAadInput,
} from '@kilocode/worker-utils/gitlab-credential';

type CredentialEncryptionKey = {
  keyId: string;
  publicKeyPem: Buffer;
  publicKeySha256: string;
};

export class GitLabCredentialEncryptionError extends Error {
  constructor() {
    super('GitLab credential encryption is not configured');
    this.name = 'GitLabCredentialEncryptionError';
  }
}

function requireCredentialEncryptionKey(): CredentialEncryptionKey {
  const keyId = BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID;
  const encodedPublicKey = BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY;
  if (!keyId || keyId.trim() !== keyId || !encodedPublicKey) {
    throw new GitLabCredentialEncryptionError();
  }

  const publicKeyPem = Buffer.from(encodedPublicKey, 'base64');
  let publicKeySha256: string;
  try {
    if (publicKeyPem.toString('utf8').includes('PRIVATE KEY')) {
      throw new Error('Private key material is not allowed');
    }
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'rsa') {
      throw new Error('RSA public key is required');
    }
    publicKeySha256 = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
  } catch {
    throw new GitLabCredentialEncryptionError();
  }

  return { keyId, publicKeyPem, publicKeySha256 };
}

export function getGitLabCredentialEncryptionPublicKeyInfo(): {
  keyId: string;
  publicKeySha256: string;
} {
  const { keyId, publicKeySha256 } = requireCredentialEncryptionKey();
  return { keyId, publicKeySha256 };
}

export type EncryptGitLabOAuthCredentialsInput = Omit<GitLabOAuthCredentialAadInput, 'kind'> & {
  accessToken: string;
  refreshToken: string;
  oauthClientSecret: string | null;
};

export type EncryptedGitLabOAuthCredentials = {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  oauthClientSecretEncrypted: string | null;
};

export function encryptGitLabOAuthCredentials(
  input: EncryptGitLabOAuthCredentialsInput
): EncryptedGitLabOAuthCredentials {
  const encryptionKey = requireCredentialEncryptionKey();
  const encrypt = (value: string, kind: GitLabOAuthCredentialAadInput['kind']) =>
    encryptKeyedEnvelope(
      value,
      GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      encryptionKey,
      buildGitLabOAuthCredentialAad({ ...input, kind })
    );

  return {
    accessTokenEncrypted: encrypt(input.accessToken, 'access'),
    refreshTokenEncrypted: encrypt(input.refreshToken, 'refresh'),
    oauthClientSecretEncrypted:
      input.oauthClientSecret === null
        ? null
        : encrypt(input.oauthClientSecret, 'oauth-client-secret'),
  };
}

export type EncryptGitLabPersonalAccessTokenInput = GitLabPersonalAccessTokenAadInput & {
  token: string;
};

export function encryptGitLabPersonalAccessToken(
  input: EncryptGitLabPersonalAccessTokenInput
): string {
  return encryptKeyedEnvelope(
    input.token,
    GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
    requireCredentialEncryptionKey(),
    buildGitLabPersonalAccessTokenAad(input)
  );
}

export type EncryptGitLabProjectAccessTokenInput = GitLabProjectAccessTokenAadInput & {
  token: string;
};

export function encryptGitLabProjectAccessToken(
  input: EncryptGitLabProjectAccessTokenInput
): string {
  return encryptKeyedEnvelope(
    input.token,
    GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
    requireCredentialEncryptionKey(),
    buildGitLabProjectAccessTokenAad(input)
  );
}
