import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
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
 * Throws unless `dataKey` can encrypt. Callers that must not consume anything before the
 * credential is stored, such as a rotating refresh token, check this first: the KMS
 * response is only validated as non-empty.
 */
export function assertSealable(dataKey: ByokDataKey): void {
  encryptByokWithDataKey('', dataKey);
}

/**
 * Opens a KMS credential envelope; null when the row holds none. A KMS failure throws a
 * `CredentialKmsError`.
 */
export async function openKmsCredential<Envelope extends BYOKApiKeyEnvelope>(
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
