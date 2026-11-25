import { z } from 'zod';
import {
  signerOfTokenKid,
  UTS_SIGNER_COUNT,
  UtsPublicJwkSchema,
  UtsSignerIndexSchema,
} from './jwks';

/**
 * The mint Worker's internal entrypoint. Only the feed Worker binds it, with
 * `props: { caller: '<feed deployment name>' }`; the mint Worker refuses every other caller.
 */
export const UTS_SIGNER_KEYS_ENTRYPOINT = 'SignerKeys';

/** The public keys one signer object publishes: its current key, its next key, retired keys. */
export const SignerPublicKeysSchema = z
  .strictObject({
    signer: UtsSignerIndexSchema,
    keys: z.array(UtsPublicJwkSchema).min(1),
  })
  .refine(
    entry => entry.keys.every(key => signerOfTokenKid(key.kid) === entry.signer),
    'every kid must be a token kid of this signer'
  );
export type SignerPublicKeys = z.infer<typeof SignerPublicKeysSchema>;

/** What `SignerKeys.publicKeys()` answers: every signer exactly once, or a refusal. */
export const SignerKeysResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    signers: z
      .array(SignerPublicKeysSchema)
      .length(UTS_SIGNER_COUNT)
      .refine(
        signers => new Set(signers.map(entry => entry.signer)).size === UTS_SIGNER_COUNT,
        'every signer exactly once'
      ),
  }),
  z.strictObject({ status: z.literal('denied') }),
]);
export type SignerKeysResult = z.infer<typeof SignerKeysResultSchema>;

/** The entrypoint as the feed Worker's service binding exposes it; the answer is parsed there. */
export type SignerKeysBinding = {
  publicKeys(): Promise<unknown>;
};
