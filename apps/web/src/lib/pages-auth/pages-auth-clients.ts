import 'server-only';
import crypto from 'node:crypto';
import { PAGES_AUTH_SECRET, PAGES_DEV_AUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

/**
 * Where a Pages deployment receives the browser back, on its own origin. The
 * path is fixed here, so a sign-in can never be sent anywhere else on a Pages
 * origin, and Pages keeps the page a person was going to on its own side.
 */
export const PAGES_AUTH_CALLBACK_PATH = '/api/auth/kilo/callback';

/** Shortest secret a deployment may be configured with. */
const MIN_SECRET_LENGTH = 32;

type PagesAuthClient = {
  /** The exact origin the deployment is served from. */
  origin: string;
  /** What the deployment presents at the code exchange. */
  secret: string;
};

/**
 * The Pages deployments that may sign people in with their Kilo session. A
 * deployment is live only while its secret is configured: without one, its
 * origin is refused at both the sign-in page and the exchange.
 */
const PAGES_AUTH_CLIENTS: readonly PagesAuthClient[] = [
  { origin: 'https://pages.kiloapps.io', secret: PAGES_AUTH_SECRET },
  { origin: 'https://pages-dev.kiloapps.io', secret: PAGES_DEV_AUTH_SECRET },
];

function findPagesAuthClient(origin: string): PagesAuthClient | null {
  const client = PAGES_AUTH_CLIENTS.find(candidate => candidate.origin === origin);
  return client && client.secret.length >= MIN_SECRET_LENGTH ? client : null;
}

/** Whether `origin` is a Pages deployment that people may sign in to. */
export function isPagesAuthOrigin(origin: string): boolean {
  return findPagesAuthClient(origin) !== null;
}

/**
 * Whether `secret` is the one configured for the Pages deployment at `origin`.
 * Both sides are hashed first, so the comparison takes the same time whatever
 * the length of the value presented.
 */
export function isPagesAuthClient(origin: string, secret: string | null): boolean {
  const client = findPagesAuthClient(origin);
  if (!client || !secret) return false;
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(secret), digest(client.secret));
}

/** The address on a Pages origin that finishes a sign-in. */
export function pagesAuthCallbackUrl(origin: string, params: { code: string; state: string }) {
  const url = new URL(PAGES_AUTH_CALLBACK_PATH, origin);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}
