import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

/**
 * How long a proof is good for: the length of a Pages session, which starts at
 * the exchange that hands the proof out. OAuth refreshes on the Pages side
 * renew nothing here, so search stops this long after the person last signed
 * in.
 */
const PROOF_TTL_SECONDS = 8 * 60 * 60;

/**
 * Every signed token in this app shares one key, so the marker is what stops a
 * sign-in code, or a token minted for any other purpose, from passing as a
 * proof.
 */
const PROOF_PURPOSE = 'pages-member-search';

type PagesMemberSearchProof = {
  userId: string;
  audience: string;
};

function parseProof(payload: Record<string, unknown>): PagesMemberSearchProof | null {
  if (payload.purpose !== PROOF_PURPOSE) return null;
  if (typeof payload.userId !== 'string' || payload.userId.length === 0) return null;
  if (typeof payload.audience !== 'string' || payload.audience.length === 0) return null;
  return { userId: payload.userId, audience: payload.audience };
}

/**
 * A proof that `userId` signed in to the Pages deployment `audience` names.
 * Pages keeps it with the session and sends it with each member search, so the
 * deployment secret alone can't search on anyone's behalf.
 *
 * It vouches for identity only. Membership is checked live on every search.
 */
export function createPagesMemberSearchProof(proof: PagesMemberSearchProof): string {
  return createSignedToken({ purpose: PROOF_PURPOSE, ...proof });
}

/**
 * Whether `proof` was minted for `userId` on the deployment `audience` names
 * and is still fresh.
 */
export function isPagesMemberSearchProofFor(
  proof: string,
  { userId, audience }: PagesMemberSearchProof
): boolean {
  const verified = verifySignedToken(proof, { ttlSeconds: PROOF_TTL_SECONDS, parse: parseProof });
  return verified !== null && verified.userId === userId && verified.audience === audience;
}
