import { FEED_HEAD_TYPE, type FeedHeadPayload } from '@kilocode/uts-contracts';
import { SignJWT } from 'jose';

/**
 * A signed feed head (design 5.6): a compact JWS with header `alg: EdDSA`,
 * `typ: kilo-feed-head+jwt` and the feed key's `kid`, over `{ iat, list_hash }`. `iat` is the
 * signing time in whole seconds, rounded down.
 */
export async function signFeedHead(
  signingKey: CryptoKey,
  kid: string,
  payload: FeedHeadPayload
): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', typ: FEED_HEAD_TYPE, kid })
    .sign(signingKey);
}
