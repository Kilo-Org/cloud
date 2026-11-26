import { createHash } from 'node:crypto';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { DualWrittenCredentialEnvelope, EncryptedData } from '@kilocode/db/schema-types';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  decryptByokEnvelope,
  encryptByokWithDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';

/*
 * Credentials that move from the static `BYOK_ENCRYPTION_KEY` to the BYOK KMS service are
 * written in both forms during the rollout: the KMS envelope, which readers prefer, and the
 * static-key ciphertext, which the previous deployment reads after a rollback. The envelope
 * records the digest of the static-key ciphertext written with it, so either form going
 * out of date is detectable:
 *
 * - Every writer here sets or clears both columns in one update, so the static-key copy is
 *   never older than the envelope.
 * - The previous deployment writes only the static-key column. Its write changes that
 *   ciphertext, the digest no longer matches, and the envelope is ignored until the
 *   backfill re-creates it. A cleared static-key column clears the credential, whatever
 *   the envelope still holds.
 */

/** SHA-256 of a static-key ciphertext; `legacyCiphertextDigestSql` computes the same value. */
export function legacyCiphertextDigest(legacy: EncryptedData): string {
  return createHash('sha256').update(`${legacy.iv}.${legacy.data}.${legacy.authTag}`).digest('hex');
}

/** `legacyCiphertextDigest` of a static-key ciphertext column, computed by PostgreSQL. */
export function legacyCiphertextDigestSql(column: AnyColumn): SQL<string> {
  return sql<string>`encode(sha256(convert_to((${column} ->> 'iv') || '.' || (${column} ->> 'data') || '.' || (${column} ->> 'authTag'), 'UTF8')), 'hex')`;
}

/**
 * The KMS service did not open a current envelope. Distinct from a database or parse
 * failure, so a caller can treat an unreadable credential differently from an unreachable
 * database. The cause is kept for debugging and never carries the plaintext.
 */
export class CredentialKmsError extends Error {
  /** The name of the underlying failure, safe to log; its message is not. */
  readonly causeName: string;

  constructor(cause: unknown) {
    super('The BYOK KMS service did not open the credential envelope', { cause });
    this.name = 'CredentialKmsError';
    this.causeName = cause instanceof Error ? cause.name : 'UnknownError';
  }
}

/**
 * Throws unless `dataKey` and the static key can both encrypt. Callers that must not
 * consume anything before the credential is stored, such as a rotating refresh token,
 * check this first: the KMS response is only validated as non-empty.
 */
export function assertSealable(dataKey: ByokDataKey): void {
  sealDualWrittenCredential('', dataKey);
}

export type DualWrittenCredential = {
  legacy: EncryptedData;
  envelope: DualWrittenCredentialEnvelope;
};

/**
 * Encrypts `plaintext` in both forms. The data key carries no plaintext, so callers create
 * it before any transaction and seal inside it.
 */
export function sealDualWrittenCredential(
  plaintext: string,
  dataKey: ByokDataKey
): DualWrittenCredential {
  const legacy = encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);
  return {
    legacy,
    envelope: {
      ...encryptByokWithDataKey(plaintext, dataKey),
      legacy_digest: legacyCiphertextDigest(legacy),
    },
  };
}

/**
 * The envelope of a credential whose static-key ciphertext is already stored, for the
 * backfill: the ciphertext is left as it is and the envelope records its digest.
 */
export function envelopeForStoredLegacyCiphertext(
  plaintext: string,
  legacy: EncryptedData,
  dataKey: ByokDataKey
): DualWrittenCredentialEnvelope {
  return {
    ...encryptByokWithDataKey(plaintext, dataKey),
    legacy_digest: legacyCiphertextDigest(legacy),
  };
}

/** True when the envelope was written together with the static-key ciphertext the row holds. */
export function isEnvelopeCurrent<Envelope extends DualWrittenCredentialEnvelope>(
  legacy: EncryptedData,
  envelope: Envelope | null
): envelope is Envelope {
  return envelope !== null && envelope.legacy_digest === legacyCiphertextDigest(legacy);
}

/**
 * Reads a dual-written credential: null when the static-key column is cleared, the KMS
 * envelope when it is current, and the static-key copy only while no current envelope
 * exists. A KMS failure throws instead of falling back to the static-key copy, so a
 * refusal or an outage of the KMS service is never bypassed. A static-key copy that does
 * not decrypt reads as null, as it did before envelopes existed.
 */
export async function openDualWrittenCredential<Envelope extends DualWrittenCredentialEnvelope>(
  legacy: EncryptedData | null,
  envelope: Envelope | null,
  contextFor: (envelope: Envelope) => ByokKmsContext
): Promise<string | null> {
  if (legacy === null) return null;
  if (isEnvelopeCurrent(legacy, envelope)) {
    try {
      return await decryptByokEnvelope(envelope, contextFor(envelope));
    } catch (error) {
      throw new CredentialKmsError(error);
    }
  }
  return openStaticKeyCopy(legacy);
}

/**
 * The static-key copy alone, null when it does not decrypt. Only for comparing a stored
 * credential with one a caller already holds, never for serving it: readers must use
 * `openDualWrittenCredential`, which does not bypass the KMS service.
 */
export function openStaticKeyCopy(legacy: EncryptedData): string | null {
  try {
    return decryptApiKey(legacy, BYOK_ENCRYPTION_KEY);
  } catch {
    return null;
  }
}
