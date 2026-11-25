import { z } from 'zod';
import {
  signerOfTokenKid,
  UTS_SIGNER_COUNT,
  UtsPublicJwkSchema,
  UtsSignerIndexSchema,
} from './jwks';

/**
 * The mint Worker's internal signer-keys route. Only the feed Worker reaches it, over a service
 * binding to the mint Worker's default entrypoint with `props: { caller: '<feed deployment name>' }`,
 * so the read runs in the mint Worker's placed fetch handler. The mint Worker answers every other
 * request on this path as an unknown path (404).
 */
export const UTS_SIGNER_KEYS_PATH = '/internal/signer-keys';

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

/**
 * The body of the signer-keys route: every signer exactly once (200); `misconfigured` when a signer
 * object refuses to load under its name or jurisdiction, a deploy error that retries cannot fix
 * (500); `unavailable` when a signer call failed after its retries (503).
 */
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
  z.strictObject({ status: z.literal('misconfigured') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type SignerKeysResult = z.infer<typeof SignerKeysResultSchema>;

/** The HTTP status the mint Worker sends with each result. */
export const SIGNER_KEYS_HTTP_STATUS: Readonly<Record<SignerKeysResult['status'], number>> = {
  ok: 200,
  misconfigured: 500,
  unavailable: 503,
};
