import { base64urlToBytes, bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { z } from 'zod';
import { canonicalJson } from './canonical';

/** The public half of the checkpoint signing key, published as a JWK set. */
export const CheckpointPublicKeySchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
  kid: z.string().min(1),
  use: z.literal('sig'),
  alg: z.literal('EdDSA'),
});
export type CheckpointPublicKey = z.infer<typeof CheckpointPublicKeySchema>;

/** RFC 7638 thumbprint over the required members in lexicographic order. */
export async function ed25519Thumbprint(jwk: {
  crv: string;
  kty: string;
  x: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
  );
  return bytesToBase64url(new Uint8Array(digest));
}

export async function verifyEd25519(
  publicKey: CheckpointPublicKey,
  signature: string,
  payload: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: publicKey.x },
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    base64urlToBytes(signature),
    new TextEncoder().encode(payload)
  );
}
