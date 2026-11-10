import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

/**
 * How long a sign-in code is good for. It only has to survive one redirect to
 * Pages and Pages' call back here.
 */
const CODE_TTL_SECONDS = 60;

/**
 * Marks a signed token as a Pages sign-in code. Every signed token in this app
 * shares one key, so the marker is what stops a token minted for another
 * purpose from being accepted here.
 */
const CODE_PURPOSE = 'pages-auth';

/**
 * The `state` a Pages deployment sends: an unguessable value it keeps with the
 * browser that started the sign-in. The shape is checked so it is safe to echo
 * in a redirect.
 */
export const PAGES_AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * What a code stands for: this person, signing in to this deployment, in the
 * sign-in this `state` names.
 */
export type PagesAuthGrant = {
  userId: string;
  origin: string;
  state: string;
};

function parsePagesAuthGrant(payload: Record<string, unknown>): PagesAuthGrant | null {
  if (payload.purpose !== CODE_PURPOSE) return null;
  if (typeof payload.userId !== 'string' || payload.userId.length === 0) return null;
  if (typeof payload.origin !== 'string' || payload.origin.length === 0) return null;
  if (typeof payload.state !== 'string' || !PAGES_AUTH_STATE_PATTERN.test(payload.state)) {
    return null;
  }
  return { userId: payload.userId, origin: payload.origin, state: payload.state };
}

/**
 * A code Pages can trade for the person who signed in.
 *
 * A code is not stored, so it is not single use. It is bound instead: it is
 * good for a minute, only for the deployment and the `state` it was minted
 * for, and only when presented with that deployment's secret. Pages accepts a
 * `state` once, from the browser that started it, so a code copied out of a
 * browser signs nobody else in.
 */
export function createPagesAuthCode(grant: PagesAuthGrant): string {
  return createSignedToken({ purpose: CODE_PURPOSE, ...grant });
}

/**
 * The grant a code stands for, or null when it is missing, forged, stale or not
 * a Pages code.
 */
export function verifyPagesAuthCode(code: string | null): PagesAuthGrant | null {
  return verifySignedToken(code, {
    ttlSeconds: CODE_TTL_SECONDS,
    parse: parsePagesAuthGrant,
  });
}
