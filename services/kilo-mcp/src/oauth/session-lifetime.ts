/**
 * How long a Kilo MCP sign-in lasts. A user authorizes once and stays signed
 * in for a year; the owner's ideal of "sign in once and that's it" is one
 * option away with the pinned provider and is deliberately declined, so this
 * module is the record of the bounded maximum, why the bound is what it is,
 * and the trade-off it buys.
 *
 * Why the session is a year and not indefinite. The sliding half is a genuine
 * impossibility: the library derives the grant's absolute deadline
 * (`expiresAt = now + refreshTokenTTL`) once, at the authorization-code
 * exchange, re-saves the grant on every refresh with that same deadline, and
 * rejects a `refreshTokenTTL` returned by the refresh callback
 * (`oauth-provider.js:1964,2092,2056`). A never-ending session, by contrast,
 * IS expressible with this pinned version, and the library says so itself:
 * `refreshTokenTTL` and `clientRegistrationTTL` are documented "Set to
 * `undefined` explicitly for refresh tokens / clients that never expire"
 * (`oauth-provider.d.ts:571,:580`). An explicitly passed `undefined` survives
 * because `this.options` spreads the caller's options over the defaults
 * (`oauth-provider.js:1348-1354`); an undefined `refreshTokenTTL` then stores
 * no `expiresAt` (`:1964`), every expiry check is guarded by
 * `expiresAt !== void 0` (`:2017,:2077`), and `saveGrantWithTTL` writes no KV
 * `expiration` (`:2763-2765`). So `refreshTokenTTL: undefined` together with
 * `clientRegistrationTTL: undefined` is a session that never ends. We decline
 * it on security grounds, not because it is impossible: a grant with no stored
 * deadline has no absolute end — the credential is permanent — and because the
 * deadline lives in the grant record rather than in the option, lowering the
 * option later cannot revoke grants already minted, so shipping it is a
 * one-way door for every session minted while it is on. Rotation with strict
 * reuse detection and revocation bounds a *used* stolen token, not a dormant
 * one. One year is 26x the two-week floor the request names, so the request's
 * own fallback is comfortably met and the ideal is declined deliberately.
 *
 * Why the DCR client record outlives the grant by a month: the provider looks
 * the client up before it reads the grant (`:1636,:1648`) and defaults the
 * dynamically registered record to 90 days (`:3073`). A record expiring with
 * the grant would turn a lapsed session into `401 invalid_client` instead of
 * the `invalid_grant` an MCP client re-authorizes on, and a record expiring
 * earlier would kill a live session. The 30-day margin keeps a lapsed session
 * a re-authorization, but only while the record exists for its whole lifetime
 * at `/authorize`.
 *
 * That whole-lifetime requirement is met by renewing the record at every
 * successful authorization: the consent completion re-puts `client:<id>` with
 * `clientRegistrationTTL` (`consent.ts`). The TTL is a lifetime measured from
 * that write, so without the renewal a record written at registration would be
 * spent before a grant that starts later, and that later session would outlive
 * its own record and die as `invalid_client`. The renewal re-anchors the record
 * to each authorization, so the margin is then measured from the grant the
 * record serves.
 *
 * Security trade-off, stated explicitly: a stolen refresh token now has up to a
 * year of life. That is bounded by rotation with strict reuse detection and
 * revocation (a replayed token revokes the whole grant), a one-hour access
 * token, client-id binding, and the fact that the grant itself still dies at
 * the bound. Public PKCE clients — the MCP norm, registered with
 * `token_endpoint_auth_method=none` — carry no secret at all. A confidential
 * DCR client receives a `client_secret_expires_at` of the same length
 * (`:2613,:2635`), and the renewal extends the stored secret's usable life with
 * the record: that is the price of a record that outlives the grant.
 */

/** One signed-in session. */
export const SESSION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/** The grant's absolute deadline, fixed at the authorization-code exchange. */
export const REFRESH_TOKEN_TTL_SECONDS = SESSION_LIFETIME_SECONDS;

/** The session plus a margin, so a lapsed session is refused as `invalid_grant`. */
export const CLIENT_REGISTRATION_TTL_SECONDS = SESSION_LIFETIME_SECONDS + 30 * 24 * 60 * 60;

/**
 * The reuse guard's memory, in milliseconds. The Durable Object alarm's
 * `purgeExpired` deletes history rows past their own `expires_at`
 * (`store/oauth-store.ts:331-346`, scheduled by `alarm` at `:757-760`).
 */
export const REFRESH_HISTORY_TTL_MS = SESSION_LIFETIME_SECONDS * 1000;
