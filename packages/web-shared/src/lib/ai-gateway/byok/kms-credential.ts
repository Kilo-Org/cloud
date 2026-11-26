import { createHash } from 'node:crypto';
import type { EncryptedData, KmsCredentialEnvelope } from '@kilocode/db/schema-types';
import {
  decryptByokEnvelope,
  encryptByokWithDataKey,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';

/**
 * The KMS service did not open a credential envelope. Distinct from a database or parse
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
 * Stored in the obsolete static-key columns in place of a ciphertext. It holds no key
 * material; it only keeps a rollback to the dual-write release working, because that
 * release reads an envelope only while the envelope's `legacy_digest` matches the static-key
 * column. Remove it together with those columns.
 */
export const OBSOLETE_STATIC_KEY_PLACEHOLDER: EncryptedData = { iv: '', data: '', authTag: '' };

/** The digest the dual-write release computes for `OBSOLETE_STATIC_KEY_PLACEHOLDER`. */
const OBSOLETE_STATIC_KEY_PLACEHOLDER_DIGEST = createHash('sha256')
  .update(
    `${OBSOLETE_STATIC_KEY_PLACEHOLDER.iv}.${OBSOLETE_STATIC_KEY_PLACEHOLDER.data}.${OBSOLETE_STATIC_KEY_PLACEHOLDER.authTag}`
  )
  .digest('hex');

/**
 * Throws unless `dataKey` can encrypt. Callers that must not consume anything before the
 * credential is stored, such as a rotating refresh token, check this first: the KMS
 * response is only validated as non-empty.
 */
export function assertSealable(dataKey: ByokDataKey): void {
  encryptByokWithDataKey('', dataKey);
}

/**
 * Encrypts `plaintext` through the KMS data key. The data key carries no plaintext, so
 * callers create it before any transaction and seal inside it.
 */
export function sealKmsCredential(plaintext: string, dataKey: ByokDataKey): KmsCredentialEnvelope {
  return {
    ...encryptByokWithDataKey(plaintext, dataKey),
    legacy_digest: OBSOLETE_STATIC_KEY_PLACEHOLDER_DIGEST,
  };
}

/**
 * Opens a KMS credential envelope; null when the row holds none. A KMS failure throws a
 * `CredentialKmsError`.
 */
export async function openKmsCredential<Envelope extends KmsCredentialEnvelope>(
  envelope: Envelope | null,
  contextFor: (envelope: Envelope) => ByokKmsContext
): Promise<string | null> {
  if (envelope === null) return null;
  try {
    return await decryptByokEnvelope(envelope, contextFor(envelope));
  } catch (error) {
    throw new CredentialKmsError(error);
  }
}
