import { feedKid, tokenKid, UtsPublicJwkSchema, type UtsPublicJwk } from '@kilocode/uts-contracts';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose';
import { z } from 'zod';

export const PrivateJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
  d: z.string().min(1),
});
export type PrivateJwk = z.infer<typeof PrivateJwkSchema>;

/** One signing key as its object stores it; the private half never leaves the object. */
export type KeyMaterial = { kid: string; publicJwk: UtsPublicJwk; privateJwk: PrivateJwk };

/**
 * Generates an Ed25519 key published under the `kid` that `kidOf` builds from its RFC 7638
 * thumbprint. Extractable only so the private JWK can be written to its object's own storage; the
 * key that signs is re-imported non-extractable.
 */
async function generateKey(kidOf: (thumbprint: string) => string): Promise<KeyMaterial> {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = PrivateJwkSchema.parse(await exportJWK(pair.privateKey));
  const thumbprint = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: privateJwk.x });
  const kid = kidOf(thumbprint);
  const publicJwk = UtsPublicJwkSchema.parse({
    kty: 'OKP',
    crv: 'Ed25519',
    x: privateJwk.x,
    kid,
    alg: 'EdDSA',
    use: 'sig',
  });
  return { kid, publicJwk, privateJwk };
}

/** A token signing key for one signer object (`uts-token-<signer>-<thumbprint>`). */
export async function generateSigningKey(signer: number): Promise<KeyMaterial> {
  return await generateKey(thumbprint => tokenKid(signer, thumbprint));
}

/** A feed-head key for one feed object (`uts-feed-<feed>-<thumbprint>`). */
export async function generateFeedKey(feed: number): Promise<KeyMaterial> {
  return await generateKey(thumbprint => feedKid(feed, thumbprint));
}

export async function importSigningKey(privateJwk: PrivateJwk): Promise<CryptoKey> {
  const key = await importJWK(privateJwk, 'EdDSA', { extractable: false });
  if (!(key instanceof CryptoKey)) throw new Error('signing key did not import as a CryptoKey');
  return key;
}
