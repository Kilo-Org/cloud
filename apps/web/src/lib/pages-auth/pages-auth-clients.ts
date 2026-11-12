import 'server-only';
import crypto from 'node:crypto';
import { PAGES_AUTH_SECRET, PAGES_DEV_AUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  PAGES_AUDIENCE,
  PAGES_DEV_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

/**
 * Where a Pages deployment receives the browser back, on its own site. The
 * path is fixed here, so a sign-in can never be sent anywhere else on a Pages
 * deployment, and Pages keeps the page a person was going to on its own side.
 */
export const PAGES_AUTH_CALLBACK_PATH = '/api/auth/kilo/callback';

/** Shortest secret a deployment may be configured with. */
const MIN_SECRET_LENGTH = 32;

type PagesAuthClient = {
  /**
   * Names the deployment on the wire: in the sign-in link, the exchange body, and
   * the `aud` of tokens minted for it.
   */
  audience: string;
  /** Where the deployment is served; never accepted from a caller. */
  baseUrl: string;
  /** What the deployment presents at the exchange. */
  secret: string;
};

/**
 * The Pages deployments that may sign people in with their Kilo session. A
 * deployment is live only while its secret is configured: without one, its
 * audience is refused at both the sign-in page and the exchange.
 */
const PAGES_AUTH_CLIENTS: readonly PagesAuthClient[] = [
  {
    audience: PAGES_AUDIENCE,
    baseUrl: 'https://pages.kiloapps.io',
    secret: PAGES_AUTH_SECRET,
  },
  {
    audience: PAGES_DEV_AUDIENCE,
    baseUrl: 'https://pages-dev.kiloapps.io',
    secret: PAGES_DEV_AUTH_SECRET,
  },
];

function findPagesAuthClient(audience: string): PagesAuthClient | null {
  const client = PAGES_AUTH_CLIENTS.find(candidate => candidate.audience === audience);
  return client && client.secret.length >= MIN_SECRET_LENGTH ? client : null;
}

/** Whether `audience` names a Pages deployment that people may sign in to. */
export function isPagesAuthAudience(audience: string): boolean {
  return findPagesAuthClient(audience) !== null;
}

/**
 * Whether `secret` is the one configured for the Pages deployment `audience`
 * names. Both sides are hashed first, so the comparison is over equal lengths
 * and in constant time.
 */
export function isPagesAuthClient(audience: string, secret: string | null): boolean {
  const client = findPagesAuthClient(audience);
  if (!client || !secret) return false;
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(secret), digest(client.secret));
}

/**
 * The address on the Pages deployment `audience` names that finishes a sign-in,
 * or null when `audience` is not a live deployment.
 */
export function pagesAuthCallbackUrl(
  audience: string,
  params: { code: string; state: string }
): string | null {
  const client = findPagesAuthClient(audience);
  if (!client) return null;
  const url = new URL(PAGES_AUTH_CALLBACK_PATH, client.baseUrl);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}
