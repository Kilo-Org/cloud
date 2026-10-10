import 'server-only';

import { createHash, createPublicKey } from 'node:crypto';
import {
  GITEA_OAUTH_CREDENTIAL_ACTIVE_KEY_ID,
  GITEA_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY,
} from '@kilocode/web-shared/lib/config.server';
import { encryptKeyedEnvelope } from '@kilocode/encryption';

type CredentialEncryptionKey = {
  keyId: string;
  publicKeyPem: Buffer;
  publicKeySha256: string;
};

export class GiteaCredentialEncryptionError extends Error {
  constructor() {
    super('Gitea credential encryption is not configured');
    this.name = 'GiteaCredentialEncryptionError';
  }
}

function requireCredentialEncryptionKey(): CredentialEncryptionKey {
  const keyId = GITEA_OAUTH_CREDENTIAL_ACTIVE_KEY_ID;
  const encodedPublicKey = GITEA_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY;
  if (!keyId || keyId.trim() !== keyId || !encodedPublicKey) {
    throw new GiteaCredentialEncryptionError();
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
    throw new GiteaCredentialEncryptionError();
  }

  return { keyId, publicKeyPem, publicKeySha256 };
}

export function getGiteaCredentialEncryptionPublicKeyInfo(): {
  keyId: string;
  publicKeySha256: string;
} {
  const { keyId, publicKeySha256 } = requireCredentialEncryptionKey();
  return { keyId, publicKeySha256 };
}

export type EncryptGiteaOAuthCredentialsInput = {
  credentialId: string;
  integrationId: string;
  providerBaseUrl: string;
  authorizedByUserId: string;
  credentialVersion: number;
  accessToken: string;
  refreshToken: string;
  oauthClientSecret: string | null;
};

export type EncryptedGiteaOAuthCredentials = {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  oauthClientSecretEncrypted: string | null;
};

function buildGiteaOAuthCredentialAad(
  input: EncryptGiteaOAuthCredentialsInput,
  kind: 'access' | 'refresh' | 'oauth-client-secret'
): string {
  return JSON.stringify({
    kind,
    credential_id: input.credentialId,
    integration_id: input.integrationId,
    provider_base_url: input.providerBaseUrl,
    authorized_by_user_id: input.authorizedByUserId,
    credential_version: input.credentialVersion,
    platform: 'gitea',
  });
}

const GITEA_OAUTH_CREDENTIAL_ENVELOPE_SCHEME = 'gitea-oauth-credential-v1';

export function encryptGiteaOAuthCredentials(
  input: EncryptGiteaOAuthCredentialsInput
): EncryptedGiteaOAuthCredentials {
  const encryptionKey = requireCredentialEncryptionKey();
  const encrypt = (value: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
    encryptKeyedEnvelope(
      value,
      GITEA_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      encryptionKey,
      buildGiteaOAuthCredentialAad(input, kind)
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
