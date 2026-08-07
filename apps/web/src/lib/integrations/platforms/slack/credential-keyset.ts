import 'server-only';

import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { SLACK_CREDENTIAL_KEYSET_JSON } from '@/lib/config.server';
import type { ActiveEnvelopePublicKey, EnvelopePrivateKeySlots } from '@kilocode/encryption';

/**
 * Slack credential envelope keyset.
 *
 * Web holds both halves here, unlike the GitLab/Bitbucket platform-credential keys
 * where the private half lives only in `git-token-service`. That is a deliberate
 * choice: the Slack webhook is handled in `apps/web` and must decrypt the bot token
 * to call Slack, so an RSA split would mean a service hop per Slack event. The
 * threat this defends is a stolen database dump, not a compromise of web's
 * environment — an attacker holding web's env already holds `SLACK_CLIENT_SECRET`.
 *
 * `mcp-gateway` (`@/lib/mcp-gateway/config.ts`) is the existing precedent for a
 * keyed-envelope keyset with the private half in web, and this mirrors its env shape.
 * The keyset form (rather than three flat env vars) is what makes key rotation
 * possible: `decrypt` slots keep old ciphertext readable after `active` moves on.
 */

const ActiveKeySchema = z.object({
  keyId: z.string().min(1),
  publicKeyPem: z.string().min(1),
});

const DecryptKeySchema = z.object({
  keyId: z.string().min(1),
  privateKeyPem: z.string().min(1).optional(),
});

const KeysetSchema = z.object({
  active: ActiveKeySchema,
  decrypt: z.array(DecryptKeySchema).default([]),
});

const Base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export class SlackCredentialKeysetError extends Error {
  constructor(message = 'Slack credential encryption is not configured') {
    super(message);
    this.name = 'SlackCredentialKeysetError';
  }
}

type SlackCredentialKeyset = {
  active: ActiveEnvelopePublicKey & { keyId: string };
  privateKeys: EnvelopePrivateKeySlots;
};

function parseJsonOrBase64Json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      Base64Schema.parse(value);
      return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
      throw new SlackCredentialKeysetError(
        'SLACK_CREDENTIAL_KEYSET_JSON must contain valid JSON or base64-encoded JSON'
      );
    }
  }
}

function assertRsaPublicKey(pem: string): void {
  if (pem.includes('PRIVATE KEY')) {
    throw new SlackCredentialKeysetError('Active public key must not contain private material');
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new SlackCredentialKeysetError('Active key must be an RSA public key');
  }
}

function assertRsaPrivateKey(pem: string): void {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new SlackCredentialKeysetError('Decrypt keys must be RSA private keys');
  }
}

/**
 * A matching key ID is not proof of a matching key pair. If the active private slot
 * holds an unrelated RSA key, encryption still succeeds against the active public key
 * and every later decryption fails, so the mismatch would only surface once something
 * tried to read a credential we had already written. Compare the SPKI of the declared
 * public key with the public half derived from the private key instead.
 */
function assertActiveKeyPairMatches(publicKeyPem: string, privateKeyPem: string): void {
  const declared = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const derived = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: 'spki',
    format: 'der',
  });
  if (!declared.equals(derived)) {
    throw new SlackCredentialKeysetError(
      'SLACK_CREDENTIAL_KEYSET_JSON active public key does not match its private key'
    );
  }
}

function buildKeyset(raw: string): SlackCredentialKeyset {
  const parsed = KeysetSchema.safeParse(parseJsonOrBase64Json(raw));
  if (!parsed.success) {
    throw new SlackCredentialKeysetError('SLACK_CREDENTIAL_KEYSET_JSON has an unexpected shape');
  }

  const { active, decrypt } = parsed.data;

  // `decryptKeyedEnvelope` resolves the private half for `active.keyId` from the
  // `decrypt` slots when `active` carries no private key, so the active key must
  // appear in `decrypt` for web to be able to read what it just wrote.
  const activePrivateKeyPem = decrypt.find(
    slot => slot.keyId === active.keyId && slot.privateKeyPem
  )?.privateKeyPem;
  if (!activePrivateKeyPem) {
    throw new SlackCredentialKeysetError(
      'SLACK_CREDENTIAL_KEYSET_JSON must include a private key for the active key ID'
    );
  }

  try {
    assertRsaPublicKey(active.publicKeyPem);
    for (const slot of decrypt) {
      if (slot.privateKeyPem) assertRsaPrivateKey(slot.privateKeyPem);
    }
    assertActiveKeyPairMatches(active.publicKeyPem, activePrivateKeyPem);
  } catch (error) {
    if (error instanceof SlackCredentialKeysetError) throw error;
    throw new SlackCredentialKeysetError('SLACK_CREDENTIAL_KEYSET_JSON contains an unusable key');
  }

  return {
    active: { keyId: active.keyId, publicKeyPem: active.publicKeyPem },
    privateKeys: { active: { keyId: active.keyId }, decrypt },
  };
}

let cached: SlackCredentialKeyset | undefined;

/**
 * Resolves the keyset, memoized per process. Throws `SlackCredentialKeysetError`
 * when unconfigured or invalid — callers on the install path treat that as
 * non-fatal while the new store is still write-only.
 */
export function requireSlackCredentialKeyset(): SlackCredentialKeyset {
  if (cached) return cached;
  if (!SLACK_CREDENTIAL_KEYSET_JSON) throw new SlackCredentialKeysetError();
  cached = buildKeyset(SLACK_CREDENTIAL_KEYSET_JSON);
  return cached;
}

export function isSlackCredentialEncryptionConfigured(): boolean {
  try {
    requireSlackCredentialKeyset();
    return true;
  } catch {
    return false;
  }
}

/** Test-only: clears the memoized keyset so env changes take effect. */
export function resetSlackCredentialKeysetCacheForTests(): void {
  cached = undefined;
}
