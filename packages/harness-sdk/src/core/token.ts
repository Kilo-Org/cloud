import { Context, Data, type Effect } from 'effect';

class TokenError extends Data.TaggedError('TokenError')<{
  readonly cause: unknown;
}> {}

/**
 * Supplies the credential for one call.
 *
 * This is a plugin because a token is not a constant. The kilo token carries an
 * expiry, so a session that outlives it starts failing with 401 while holding a
 * string it still believes in. Asking per call lets a plugin refresh, read a
 * keychain, or mint a short-lived token, without the package knowing how.
 *
 * The call is on the request path, so a plugin that fetches must cache; the
 * package asks every time and does not cache on the plugin's behalf.
 */
interface TokenSourceService {
  readonly get: () => Effect.Effect<string, TokenError>;
}

class TokenSource extends Context.Tag('harness/TokenSource')<TokenSource, TokenSourceService>() {}

export type { TokenSourceService };
export { TokenError, TokenSource };
