import { z } from 'zod';
import {
  signerOfTokenKid,
  UTS_SIGNER_COUNT,
  UtsPublicJwkSchema,
  UtsSignerIndexSchema,
  type UtsPublicJwk,
} from './jwks';

/**
 * The mint Worker's internal signer-keys route. Only the feed Worker reaches it, over a service
 * binding to the mint Worker's default entrypoint with `props: { caller: '<feed deployment name>' }`,
 * so the read runs in the mint Worker's placed fetch handler. The mint Worker answers every other
 * request on this path as an unknown path (404).
 */
export const UTS_SIGNER_KEYS_PATH = '/internal/signer-keys';

/**
 * How long a signer's last good keys stand in for its failed reads, at the mint Worker and at the
 * feed Worker alike. Both count from the signer read, as the key set's oldest-age header
 * (`UTS_JWKS_OLDEST_AGE_HEADER`) does, so a verifier that counts that header drops those keys 24
 * hours after that read too (design 5.7, 7).
 */
export const UTS_SIGNER_KEYS_HOLD_MS = 24 * 60 * 60 * 1000;

/** The public keys one signer object publishes: its current key, its next key, retired keys. */
export type SignerPublicKeys = { signer: number; keys: UtsPublicJwk[] };

/**
 * One signer in the route's answer:
 * - `ok`: its keys as its signer object answered at `readAt` (epoch milliseconds), by the read
 *   that answers or, after this read's call failed, by an earlier one under 24 hours old;
 * - `misconfigured`: the object refused to load under its name or jurisdiction, a deploy error
 *   that retries cannot fix, and no keys under 24 hours old are held;
 * - `unavailable`: the call failed after its retries, and no keys under 24 hours old are held.
 */
export const SignerKeysEntrySchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      signer: UtsSignerIndexSchema,
      status: z.literal('ok'),
      keys: z.array(UtsPublicJwkSchema).min(1),
      readAt: z.number().int().positive(),
    })
    .refine(
      entry => entry.keys.every(key => signerOfTokenKid(key.kid) === entry.signer),
      'every kid must be a token kid of this signer'
    ),
  z.strictObject({ signer: UtsSignerIndexSchema, status: z.literal('misconfigured') }),
  z.strictObject({ signer: UtsSignerIndexSchema, status: z.literal('unavailable') }),
]);
export type SignerKeysEntry = z.infer<typeof SignerKeysEntrySchema>;

function uniqueKids(entries: readonly SignerKeysEntry[]): boolean {
  const kids = entries.flatMap(entry => (entry.status === 'ok' ? entry.keys : [])).map(k => k.kid);
  return new Set(kids).size === kids.length;
}

/** The body of the signer-keys route: every signer exactly once, and no `kid` twice. */
export const SignerKeysAnswerSchema = z.strictObject({
  signers: z
    .array(SignerKeysEntrySchema)
    .length(UTS_SIGNER_COUNT)
    .refine(
      signers => new Set(signers.map(entry => entry.signer)).size === UTS_SIGNER_COUNT,
      'every signer exactly once'
    )
    .refine(uniqueKids, 'duplicate kid'),
});
export type SignerKeysAnswer = z.infer<typeof SignerKeysAnswerSchema>;

/**
 * The HTTP status the mint Worker sends with an answer: 200 when every signer has keys; otherwise
 * 500 when a signer object is misconfigured, else 503. The body is the whole answer either way, so
 * the feed Worker still takes the keys of every signer that has them.
 */
export function signerKeysHttpStatus(answer: SignerKeysAnswer): 200 | 500 | 503 {
  if (answer.signers.some(entry => entry.status === 'misconfigured')) return 500;
  if (answer.signers.some(entry => entry.status === 'unavailable')) return 503;
  return 200;
}
