import { tokenKid, UtsPublicJwkSchema, type UtsPublicJwk } from '@kilocode/uts-contracts';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose';
import { z } from 'zod';

export const PrivateJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
  d: z.string().min(1),
});
export type PrivateJwk = z.infer<typeof PrivateJwkSchema>;

/** One signing key as its signer object stores it; the private half never leaves the object. */
export type KeyMaterial = { kid: string; publicJwk: UtsPublicJwk; privateJwk: PrivateJwk };

/**
 * Generates an Ed25519 key for one signer object. Extractable only so the private JWK can be
 * written to that object's own storage; the key that signs is re-imported non-extractable.
 */
export async function generateSigningKey(signer: number): Promise<KeyMaterial> {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = PrivateJwkSchema.parse(await exportJWK(pair.privateKey));
  const thumbprint = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: privateJwk.x });
  const kid = tokenKid(signer, thumbprint);
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

export async function importSigningKey(privateJwk: PrivateJwk): Promise<CryptoKey> {
  const key = await importJWK(privateJwk, 'EdDSA', { extractable: false });
  if (!(key instanceof CryptoKey)) throw new Error('signing key did not import as a CryptoKey');
  return key;
}
