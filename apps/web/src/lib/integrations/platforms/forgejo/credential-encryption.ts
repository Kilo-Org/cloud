import 'server-only';

import { createHash, createPublicKey } from 'node:crypto';
import {
  FORGEJO_OAUTH_CREDENTIAL_ACTIVE_KEY_ID,
  FORGEJO_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY,
} from '@kilocode/web-shared/lib/config.server';
import { encryptKeyedEnvelope } from '@kilocode/encryption';

type CredentialEncryptionKey = {
  keyId: string;
  publicKeyPem: Buffer;
  publicKeySha256: string;
};

export class ForgejoCredentialEncryptionError extends Error {
  constructor() {
    super('Forgejo credential encryption is not configured');
    this.name = 'ForgejoCredentialEncryptionError';
  }
}

function requireCredentialEncryptionKey(): CredentialEncryptionKey {
  const keyId = FORGEJO_OAUTH_CREDENTIAL_ACTIVE_KEY_ID;
  const encodedPublicKey = FORGEJO_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY;
  if (!keyId || keyId.trim() !== keyId || !encodedPublicKey) {
    throw new ForgejoCredentialEncryptionError();
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
    throw new ForgejoCredentialEncryptionError();
  }

  return { keyId, publicKeyPem, publicKeySha256 };
}

export function getForgejoCredentialEncryptionPublicKeyInfo(): {
  keyId: string;
  publicKeySha256: string;
} {
  const { keyId, publicKeySha256 } = requireCredentialEncryptionKey();
  return { keyId, publicKeySha256 };
}

export type EncryptForgejoOAuthCredentialsInput = {
  credentialId: string;
  integrationId: string;
  providerBaseUrl: string;
  authorizedByUserId: string;
  credentialVersion: number;
  accessToken: string;
  refreshToken: string;
  oauthClientSecret: string | null;
};

export type EncryptedForgejoOAuthCredentials = {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  oauthClientSecretEncrypted: string | null;
};

function buildForgejoOAuthCredentialAad(
  input: EncryptForgejoOAuthCredentialsInput,
  kind: 'access' | 'refresh' | 'oauth-client-secret'
): string {
  return JSON.stringify({
    kind,
    credential_id: input.credentialId,
    integration_id: input.integrationId,
    provider_base_url: input.providerBaseUrl,
    authorized_by_user_id: input.authorizedByUserId,
    credential_version: input.credentialVersion,
    platform: 'forgejo',
  });
}

const FORGEJO_OAUTH_CREDENTIAL_ENVELOPE_SCHEME = 'forgejo-oauth-credential-v1';

export function encryptForgejoOAuthCredentials(
  input: EncryptForgejoOAuthCredentialsInput
): EncryptedForgejoOAuthCredentials {
  const encryptionKey = requireCredentialEncryptionKey();
  const encrypt = (value: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
    encryptKeyedEnvelope(
      value,
      FORGEJO_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      encryptionKey,
      buildForgejoOAuthCredentialAad(input, kind)
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
