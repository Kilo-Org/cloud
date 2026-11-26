import { z } from 'zod';

export const UtsEnvironmentSchema = z.enum(['production', 'staging', 'development']);
export type UtsEnvironment = z.infer<typeof UtsEnvironmentSchema>;

/** Path of the UTS key set on the feed Worker's origin. */
export const UTS_JWKS_PATH = '/.well-known/jwks.json';

/** RFC 8414 section 3: the metadata of an issuer without a path component. */
export const UTS_AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** Design 5.7: a verifier keeps the key set 5 minutes and may serve it up to a day on error. */
const UTS_JWKS_MAX_AGE_SECONDS = 300;
const UTS_JWKS_STALE_IF_ERROR_SECONDS = 86_400;

/**
 * The key set's `Cache-Control` for a set whose oldest keys were read from their signer objects
 * `ageSeconds` ago. The feed Worker sends that age as `Age` beside it, and both limits shrink by it,
 * so a verifier keeps no key longer than 5 minutes, or 24 hours on error, after its signer read.
 */
export function utsJwksCacheControl(ageSeconds: number): string {
  const maxAge = Math.max(0, UTS_JWKS_MAX_AGE_SECONDS - ageSeconds);
  const staleIfError = Math.max(0, UTS_JWKS_STALE_IF_ERROR_SECONDS - ageSeconds);
  return `max-age=${maxAge}, stale-if-error=${staleIfError}`;
}

export type UtsEndpoints = {
  /** The exact `iss` of every token this environment's UTS signs (design 7). */
  issuer: string;
  /** Origin of the feed Worker, which serves the key set and, later, the revocation feed. */
  feedOrigin: string;
  /** The `jwks_uri` of the issuer's metadata. */
  jwksUri: string;
};

function endpoints(issuer: string, feedOrigin: string): UtsEndpoints {
  return { issuer, feedOrigin, jwksUri: `${feedOrigin}${UTS_JWKS_PATH}` };
}

/**
 * Where each environment's UTS lives. The mint Worker serves the issuer origin; the feed Worker,
 * which runs without placement, serves the key set. Development is `wrangler dev` on fixed ports.
 */
export const UTS_ENDPOINTS: Readonly<Record<UtsEnvironment, UtsEndpoints>> = {
  production: endpoints('https://uts.kiloapps.io', 'https://uts-feed.kiloapps.io'),
  staging: endpoints('https://uts-staging.kiloapps.io', 'https://uts-feed-staging.kiloapps.io'),
  development: endpoints('http://localhost:8800', 'http://localhost:8801'),
};
