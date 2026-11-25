import { z } from 'zod';

export const UtsEnvironmentSchema = z.enum(['production', 'staging', 'development']);
export type UtsEnvironment = z.infer<typeof UtsEnvironmentSchema>;

/** Path of the UTS key set on the feed Worker's origin. */
export const UTS_JWKS_PATH = '/.well-known/jwks.json';

/** RFC 8414 section 3: the metadata of an issuer without a path component. */
export const UTS_AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** Design 5.7: a verifier keeps the key set 5 minutes and may serve it up to a day on error. */
export const UTS_JWKS_CACHE_CONTROL = 'max-age=300, stale-if-error=86400';

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
