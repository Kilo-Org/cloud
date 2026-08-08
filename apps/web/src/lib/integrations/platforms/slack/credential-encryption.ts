import 'server-only';

import { decryptKeyedEnvelope, encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  buildSlackOAuthCredentialAad,
  type SlackOAuthCredentialAadInput,
  type SlackOAuthSecretKind,
} from '@kilocode/worker-utils/slack-credential';
import { requireSlackCredentialKeyset } from './credential-keyset';

/**
 * Encrypt/decrypt for `slack_oauth_credentials` ciphertext columns.
 *
 * Every ciphertext is bound by AAD to its row id, parent integration, Slack team,
 * owner, secret kind, and `credential_version`. Consequences worth stating plainly:
 *
 * - Copying a ciphertext to another row, another workspace, or another owner makes it
 *   undecryptable, so a stolen dump cannot be reassembled into a working credential.
 * - Re-encrypting under a new `credentialVersion` invalidates the previous ciphertext
 *   for that version, so a replayed old row fails authentication rather than
 *   resurrecting a superseded token.
 * - Decryption therefore requires the exact identity fields that were current at
 *   write time. Callers must pass the row's own stored `credential_version`, not a
 *   version they intend to write.
 */

export type SlackCredentialIdentity = Omit<SlackOAuthCredentialAadInput, 'kind'>;

export class SlackCredentialDecryptionError extends Error {
  constructor(
    readonly kind: SlackOAuthSecretKind,
    options?: { cause?: unknown }
  ) {
    super(`Failed to decrypt Slack ${kind} token`);
    this.name = 'SlackCredentialDecryptionError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function encryptSlackCredentialSecret(
  value: string,
  identity: SlackCredentialIdentity,
  kind: SlackOAuthSecretKind
): string {
  return encryptKeyedEnvelope(
    value,
    SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    requireSlackCredentialKeyset().active,
    buildSlackOAuthCredentialAad({ ...identity, kind })
  );
}

export function decryptSlackCredentialSecret(
  ciphertext: string,
  identity: SlackCredentialIdentity,
  kind: SlackOAuthSecretKind
): string {
  try {
    return decryptKeyedEnvelope(
      ciphertext,
      SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      requireSlackCredentialKeyset().privateKeys,
      buildSlackOAuthCredentialAad({ ...identity, kind })
    );
  } catch (error) {
    // Never surface the underlying message: it can carry key IDs and envelope
    // internals. Callers distinguish "cannot read" from "no credential" by type.
    throw new SlackCredentialDecryptionError(kind, { cause: error });
  }
}
