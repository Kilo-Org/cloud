import { z } from 'zod';
import {
  signerOfTokenKid,
  UTS_SIGNER_COUNT,
  UtsPublicJwkSchema,
  UtsSignerIndexSchema,
  type UtsPublicJwk,
} from './jwks';

/**
 * The mint Worker's named entrypoint that answers the feed Worker's signer-keys read. Only the
 * feed Worker binds it, with `props: { caller: '<feed deployment name>' }`; a service binding
 * delivers `props` to a named entrypoint, as for the STS broker. Placement does not apply to a
 * named entrypoint, so the read and its 16 signer calls run where the feed Worker runs
 * (design 5.2, 5.7).
 */
export const UTS_SIGNER_KEYS_ENTRYPOINT = 'SignerKeys';

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
 * One signer in the signer-keys answer:
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

/** The signer-keys answer: every signer exactly once, and no `kid` twice. */
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
 * The result of one `signerKeys()` call: the whole answer, which carries each signer's keys or
 * failure, or `refused` when the binding's `props.caller` is not the feed Worker of the mint
 * Worker's own environment.
 */
export const SignerKeysReadSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('answered'), answer: SignerKeysAnswerSchema }),
  z.strictObject({ status: z.literal('refused') }),
]);
export type SignerKeysRead = z.infer<typeof SignerKeysReadSchema>;

/**
 * The `SignerKeys` entrypoint as the feed Worker's binding exposes it. The result crosses a
 * deploy boundary, so the caller validates it with `SignerKeysReadSchema`. workerd gives the
 * object an RPC call returns a disposer, and the call stays open until it runs, so the caller
 * disposes the result once it holds the validated copy (Partial: a test double has none).
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export type SignerKeysBinding = { signerKeys(): Promise<object & Partial<Disposable>> };
