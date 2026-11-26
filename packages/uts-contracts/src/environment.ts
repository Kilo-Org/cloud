import { z } from 'zod';

export const UtsEnvironmentSchema = z.enum(['production', 'staging', 'development']);
export type UtsEnvironment = z.infer<typeof UtsEnvironmentSchema>;

/**
 * The mint Worker's deployed name in each environment: the `props.caller` its service bindings
 * carry to other Workers' named entrypoints, such as the Notifications Worker's `SecurityNotices`.
 * `services/uts/test/repo` fails when the mint Worker's wrangler config deploys other names.
 */
export const UTS_MINT_DEPLOYMENTS: Readonly<Record<UtsEnvironment, string>> = {
  production: 'uts',
  staging: 'uts-staging',
  development: 'uts-local',
};

/** Path of the UTS key set on the feed Worker's origin. */
export const UTS_JWKS_PATH = '/.well-known/jwks.json';

/** RFC 8414 section 3: the metadata of an issuer without a path component. */
export const UTS_AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * Design 5.7: a verifier keeps the key set 5 minutes and may serve it up to a day on error. The
 * feed Worker sends these limits unchanged beside `Age` (RFC 9111 section 5.1), so a standard cache
 * counts the age once.
 */
export const UTS_JWKS_CACHE_CONTROL = 'max-age=300, stale-if-error=86400';

/**
 * Response header with the seconds since the oldest keys in the key set were read from their
 * signer object. `Age` counts from the newest read, which says when the set last got fresh keys,
 * and drives the 5-minute lifetime; this header drives only the verifier's 24-hour last-good limit,
 * so one failing signer neither expires every response nor keeps any key past 24 hours after its
 * last good read (design 5.7, 7, decision Q55).
 */
export const UTS_JWKS_OLDEST_AGE_HEADER = 'Kilo-Key-Set-Oldest-Age';

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
