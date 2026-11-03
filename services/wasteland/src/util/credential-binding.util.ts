/**
 * Decides what a verified flow writes into `wasteland_credentials`.
 *
 * A stored credential is one unit: the ciphertext it holds belongs to
 * the `dolthub_org` recorded beside it, so an op that uses the stored
 * ciphertext (see `wanted-board-ops-sdk.ts` and `branch-ops.ts`) reaches
 * the org that ciphertext was stored for. A flow therefore writes the
 * token it actually used together with the org that token acted for, and
 * keeps the stored ciphertext only while the row already names that same
 * org.
 */

import { isSameDolthubOrg } from '@kilocode/wl-sdk';
import { deriveEncryptionKey, encryptToken } from './crypto.util';
import { resolveSecret } from './secret.util';

export type StoredCredentialRow = { encrypted_token: string; dolthub_org: string };

export type CredentialTokenBinding =
  | { status: 'bound'; encryptedToken: string; dolthubOrg: string }
  | { status: 'key-unavailable' };

/**
 * Pair the token a verified flow used with the org it acted for.
 *
 * `org` is the org the flow resolved for this token — the fresh OAuth
 * account, or the org the stored ciphertext was decrypted for. When the
 * row already names it (compared case-insensitively, as the rest of the
 * service compares orgs) the stored ciphertext stays and so does the
 * org it was recorded with; otherwise the flow's own token is encrypted
 * for that org, which needs the encryption key.
 */
export async function bindCredentialToken(
  env: Pick<Env, 'WASTELAND_ENCRYPTION_KEY'>,
  input: { existing: StoredCredentialRow | null; org: string; token: string }
): Promise<CredentialTokenBinding> {
  if (input.existing !== null && isSameDolthubOrg(input.existing.dolthub_org, input.org)) {
    return {
      status: 'bound',
      encryptedToken: input.existing.encrypted_token,
      dolthubOrg: input.existing.dolthub_org,
    };
  }

  const rawKey = await resolveSecret(env.WASTELAND_ENCRYPTION_KEY);
  if (!rawKey) return { status: 'key-unavailable' };
  const cryptoKey = await deriveEncryptionKey(rawKey);
  return {
    status: 'bound',
    encryptedToken: await encryptToken(input.token, cryptoKey),
    dolthubOrg: input.org,
  };
}
