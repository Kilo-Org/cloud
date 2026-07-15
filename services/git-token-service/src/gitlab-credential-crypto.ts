import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  decryptKeyedEnvelope,
  encryptKeyedEnvelope,
  parseKeyedEnvelope,
} from '@kilocode/encryption';
import type {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
} from '@kilocode/worker-utils/gitlab-credential';

type Secret = SecretsStoreSecret | string | undefined;

export type GitLabCredentialCryptoEnv = {
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY?: Secret;
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY?: Secret;
};

type GitLabCredentialEnvelopeScheme =
  | typeof GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME
  | typeof GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME
  | typeof GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME;

export type GitLabCredentialDecryptionResult =
  | { status: 'available'; token: string }
  | { status: 'temporarily_unavailable' }
  | { status: 'unreadable' };

export type GitLabCredentialAuditDecryptionResult =
  | { status: 'available'; token: string }
  | { status: 'configuration_error' }
  | { status: 'invalid_envelope' }
  | { status: 'unknown_key' }
  | { status: 'decrypt_failed' };

async function resolveSecret(secret: Secret): Promise<string | null> {
  if (!secret) return null;
  const value = typeof secret === 'string' ? secret : await secret.get();
  return value || null;
}

export class GitLabCredentialCrypto {
  constructor(private env: GitLabCredentialCryptoEnv) {}

  async auditKeyIdentity(): Promise<
    | { status: 'available'; keyId: string; publicKeySha256: string }
    | { status: 'configuration_error' }
  > {
    const key = await this.loadActiveKey();
    if (key.status !== 'available') return { status: 'configuration_error' };
    return {
      status: 'available',
      keyId: key.keyId,
      publicKeySha256: key.publicKeySha256,
    };
  }

  async encrypt(input: {
    plaintext: string;
    scheme: GitLabCredentialEnvelopeScheme;
    aad: string;
  }): Promise<{ status: 'available'; ciphertext: string } | { status: 'temporarily_unavailable' }> {
    const key = await this.loadActiveKey();
    if (key.status !== 'available') return key;
    try {
      return {
        status: 'available',
        ciphertext: encryptKeyedEnvelope(
          input.plaintext,
          input.scheme,
          { keyId: key.keyId, publicKeyPem: key.publicKeyPem },
          input.aad
        ),
      };
    } catch {
      return { status: 'temporarily_unavailable' };
    }
  }

  async decrypt(input: {
    ciphertext: string;
    scheme: GitLabCredentialEnvelopeScheme;
    aad: string;
  }): Promise<GitLabCredentialDecryptionResult> {
    const key = await this.loadActiveKey();
    if (key.status !== 'available') return key;

    try {
      const envelope = parseKeyedEnvelope(input.ciphertext, input.scheme);
      if (envelope.keyId !== key.keyId) return { status: 'unreadable' };
      return {
        status: 'available',
        token: decryptKeyedEnvelope(
          input.ciphertext,
          input.scheme,
          { active: { keyId: key.keyId, privateKeyPem: key.privateKeyPem } },
          input.aad
        ),
      };
    } catch {
      return { status: 'unreadable' };
    }
  }

  async auditDecrypt(input: {
    ciphertext: string;
    scheme: GitLabCredentialEnvelopeScheme;
    aad: string;
  }): Promise<GitLabCredentialAuditDecryptionResult> {
    const key = await this.loadActiveKey();
    if (key.status !== 'available') return { status: 'configuration_error' };

    let envelope: ReturnType<typeof parseKeyedEnvelope>;
    try {
      envelope = parseKeyedEnvelope(input.ciphertext, input.scheme);
    } catch {
      return { status: 'invalid_envelope' };
    }
    if (envelope.keyId !== key.keyId) return { status: 'unknown_key' };

    try {
      return {
        status: 'available',
        token: decryptKeyedEnvelope(
          input.ciphertext,
          input.scheme,
          { active: { keyId: key.keyId, privateKeyPem: key.privateKeyPem } },
          input.aad
        ),
      };
    } catch {
      return { status: 'decrypt_failed' };
    }
  }

  private async loadActiveKey(): Promise<
    | {
        status: 'available';
        keyId: string;
        publicKeyPem: string;
        privateKeyPem: string;
        publicKeySha256: string;
      }
    | { status: 'temporarily_unavailable' }
  > {
    let keyId: string | null;
    let encodedPublicKey: string | null;
    let encodedPrivateKey: string | null;
    try {
      [keyId, encodedPublicKey, encodedPrivateKey] = await Promise.all([
        resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID),
        resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY),
        resolveSecret(this.env.BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY),
      ]);
    } catch {
      return { status: 'temporarily_unavailable' };
    }
    if (!keyId || !encodedPublicKey || !encodedPrivateKey) {
      return { status: 'temporarily_unavailable' };
    }

    let publicKeyPem: string;
    let privateKeyPem: string;
    let configuredPublicKey: Buffer;
    try {
      publicKeyPem = Buffer.from(encodedPublicKey, 'base64').toString('utf8');
      privateKeyPem = Buffer.from(encodedPrivateKey, 'base64').toString('utf8');
      if (publicKeyPem.includes('PRIVATE KEY')) return { status: 'temporarily_unavailable' };

      const publicKey = createPublicKey(publicKeyPem);
      const privateKey = createPrivateKey(privateKeyPem);
      if (publicKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyType !== 'rsa') {
        return { status: 'temporarily_unavailable' };
      }
      configuredPublicKey = publicKey.export({ type: 'spki', format: 'der' });
      const derivedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
      if (!configuredPublicKey.equals(derivedPublicKey)) {
        return { status: 'temporarily_unavailable' };
      }
    } catch {
      return { status: 'temporarily_unavailable' };
    }

    return {
      status: 'available',
      keyId,
      publicKeyPem,
      privateKeyPem,
      publicKeySha256: createHash('sha256').update(configuredPublicKey).digest('hex'),
    };
  }
}
