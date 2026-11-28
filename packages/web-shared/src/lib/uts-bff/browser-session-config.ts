import { createHash, timingSafeEqual } from 'node:crypto';
import type { UtsEnvironment } from '@kilocode/uts-contracts';
import type { TRPCError } from '@trpc/server';

/**
 * The switch and the cookie names of the `kilo-web` browser sessions (design 5.1, 5.5). This
 * module stays light, so the session read can ask whether the deployment serves UTS browser
 * sessions, and whether the request carries their cookie, without loading the UTS client.
 *
 * `UTS_BROWSER_SESSIONS=on` turns the routes and the session read on, and only in the three
 * deployments UTS registers a `kilo-web` callback for: Vercel production, the `staging` custom
 * environment, and a process outside Vercel (local development and tests: `VERCEL` unset, and
 * `VERCEL_ENV` and `VERCEL_TARGET_ENV` each unset or `development`, the value the tracked
 * `apps/web/.env.test` carries; `adminNetworkDecision` reads it the same way). A deployment is
 * `production` or `preview`, so a Vercel build with a missing variable never gets cookies without
 * the `__Host-` prefix. Any other value, and every other deployment (a preview), leaves them off:
 * the routes answer 404 and the NextAuth session is read exactly as before.
 */
export function utsBrowserSessionEnvironment(
  runtime: Readonly<Record<string, string | undefined>> = process.env
): UtsEnvironment | null {
  if (runtime.UTS_BROWSER_SESSIONS !== 'on') return null;
  const { VERCEL: vercel, VERCEL_ENV: environment, VERCEL_TARGET_ENV: target } = runtime;
  if (environment === 'production' && target === 'production') return 'production';
  if (environment === 'preview' && target === 'staging') return 'staging';
  const local = (value: string | undefined) => value === undefined || value === 'development';
  if (vercel === undefined && local(environment) && local(target)) return 'development';
  return null;
}

/**
 * A UTS browser session that could not be checked (UTS, its client key or its answer unavailable).
 * The request is neither signed in nor signed out: a page shows an error instead of the sign-in
 * redirect, and an API answers 503 with `Retry-After`.
 */
export class SessionCheckUnavailableError extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super('The browser session could not be checked; retry later');
    this.name = 'SessionCheckUnavailableError';
  }
}

/**
 * The `Retry-After` header of a tRPC response whose context refused an unchecked UTS browser
 * session (`contextAuthRefusal`), for the route adapter's `responseMeta`; empty otherwise.
 */
export function sessionCheckResponseHeaders(errors: readonly TRPCError[]): Record<string, string> {
  for (const error of errors) {
    if (
      error.cause instanceof SessionCheckUnavailableError &&
      error.cause.retryAfterSeconds !== null
    ) {
      return { 'Retry-After': String(error.cause.retryAfterSeconds) };
    }
  }
  return {};
}

export type BrowserSessionCookieNames = { session: string; transaction: string };

/**
 * Over HTTPS both cookies carry the `__Host-` prefix, so the browser accepts them only Secure, on
 * `Path=/`, without `Domain`, from a secure origin: a sibling subdomain or a plain-HTTP response
 * cannot plant or overwrite them. Local development runs on plain-HTTP localhost.
 */
export function browserSessionCookieNames(environment: UtsEnvironment): BrowserSessionCookieNames {
  const prefix = environment === 'development' ? '' : '__Host-';
  return { session: `${prefix}kilo-web-session`, transaction: `${prefix}kilo-web-tx` };
}

/** Every value of cookie `name` in a `Cookie` request header. */
export function cookieValues(header: string | null, name: string): string[] {
  if (header === null) return [];
  const values: string[] = [];
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === name) {
      values.push(pair.slice(separator + 1).trim());
    }
  }
  return values;
}

const PEPPER_BINDING_LABEL = 'kilo-web session pepper v1:';
const NO_PEPPER = 'none';

/**
 * The account's web-session pepper when the session was admitted, as the session cookie keeps it:
 * a labelled SHA-256, never the pepper. Rotating the pepper (sign out everywhere, a block, an
 * account recovery) ends the UTS browser sessions bound to the old one here, exactly as it ends
 * NextAuth sessions, before UTS learns of it.
 */
export function browserSessionPepperBinding(pepper: string | null): string {
  if (pepper === null) return NO_PEPPER;
  return createHash('sha256').update(`${PEPPER_BINDING_LABEL}${pepper}`).digest('base64url');
}

export function isBrowserSessionBindingCurrent(binding: string, pepper: string | null): boolean {
  const left = Buffer.from(binding);
  const right = Buffer.from(browserSessionPepperBinding(pepper));
  return left.length === right.length && timingSafeEqual(left, right);
}
