import { UTS_SIGNER_COUNT } from '@kilocode/uts-contracts';

/**
 * The signer object a grant's tokens are signed in (design 5.7): the first 4 bytes of the grant
 * id's SHA-256, modulo 16. 2^32 is a multiple of 16, so every signer gets the same share.
 */
export async function signerForGrant(grantId: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(grantId));
  return new DataView(digest).getUint32(0) % UTS_SIGNER_COUNT;
}
