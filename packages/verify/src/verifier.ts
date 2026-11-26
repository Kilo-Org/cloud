import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TYPE,
  AccessTokenClaimsSchema,
  AudienceSchema,
  STS_SCOPE_REGISTRY,
  ScopeSchema,
  ServiceTokenClaimsSchema,
  StsEnvironmentSchema,
  TOKEN_CLOCK_SKEW_SECONDS,
  isRegisteredStsScope,
  scopeAudience,
  type AccessTokenClaims,
  type Actor,
  type StsEnvironment,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import { z } from 'zod';
import { createBootstrap, type Bootstrap, type UtsBootstrapSource } from './bootstrap';
import { createFailures, type FailureReason, type VerifyFailure } from './failure';
import { handOff, newCallScope, type CallScope, type WaitUntil } from './flight';
import {
  UTS_FEED_KID_PREFIX,
  UTS_TOKEN_KID_PREFIX,
  createKeySetCache,
  type JwksSource,
  type KeySetCache,
} from './jwks';
import { decodeJws, hasJwsExtension, verifyEd25519 } from './jws';
import { hashPat, hasPatPrefix, parsePat } from './pat-format';
import {
  createPatResolver,
  type PatConfig,
  type PatRecord,
  type PatRequest,
  type PatResolver,
} from './pat';
import {
  FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS,
  createRevocationFeed,
  maxHeadAgeForLifetime,
  type RevocationFeed,
  type RevocationFeedSource,
} from './revocation';

export type IssuerKind = 'sts' | 'uts';

/** What the UTS scope registry says about one scope of one audience (phase 3 supplies it). */
export type UtsScopeEntry = {
  /** A token for this scope must name a live grant or session in `sid`. */
  requiresSession: boolean;
  /** A PAT may carry this scope. */
  patEligible: boolean;
};
/** null when the scope is not registered for that audience. */
export type UtsScopeRegistry = (audience: string, scope: string) => UtsScopeEntry | null;

export type VerifierConfig = {
  /** This service: the one audience it accepts. */
  audience: string;
  /** The environment this service runs in: the one `env` claim it accepts, from either issuer. */
  environment: StsEnvironment;
  /** RFC 9728 protected-resource metadata URL, sent in every 401 challenge. */
  resourceMetadataUrl: string;
  sts?: {
    /** Exact `iss` of STS tokens, such as `STS_ISSUERS.production`; `https:`, or `http:` on localhost. */
    issuer: string;
    jwks: JwksSource;
    /** Defaults to `STS_SCOPE_REGISTRY`. */
    scopeRegistry?: StsScopeRegistry;
  };
  uts?: {
    /** Exact `iss` of UTS tokens; `https:`, or `http:` on localhost. */
    issuer: string;
    /**
     * The UTS key set, for warm refreshes. It holds token keys under `UTS_TOKEN_KID_PREFIX` and
     * revocation-feed keys under `UTS_FEED_KID_PREFIX`.
     */
    jwks: JwksSource;
    scopeRegistry: UtsScopeRegistry;
    /** The revocation feed, for warm refreshes; the library verifies every head and list. */
    revocation: RevocationFeedSource;
    /**
     * The UTS bootstrap endpoint. While neither the UTS key set nor the feed holds data, one call
     * loads both; without it, a cold instance fetches the key set and then the feed.
     */
    bootstrap?: UtsBootstrapSource;
    /** Without it, a PAT is refused with 401. */
    pat?: PatConfig;
  };
};

/** Whether a verifier for config `C` may receive PATs, so each call must pass a client address. */
export type AcceptsPats<C> = 'uts' extends keyof C
  ? NonNullable<C['uts' & keyof C]> extends infer U
    ? 'pat' extends keyof U
      ? U['pat' & keyof U] extends undefined
        ? false
        : true
      : false
    : false
  : false;

/** What one route accepts: exactly one issuer and exactly one scope. */
export type Route = {
  issuer: IssuerKind;
  scope: string;
  /**
   * The organization the request acts in, when the route is org-scoped: the credential must name
   * exactly this org. UTS only; STS tokens carry no org.
   */
  org?: string;
  /** The route needs a live session (`sid`), whatever its scope's registry entry says; UTS only. */
  requiresSession?: boolean;
};

/**
 * Per-request input. A verifier that accepts PATs requires `clientAddress`: the platform's client
 * address header (README), or null when the request has none, which refuses any PAT.
 */
export type VerifyContext<RequireAddress extends boolean = true> = {
  /** The request's own `waitUntil`; background refreshes this request starts run under it. */
  waitUntil: WaitUntil;
} & (RequireAddress extends true
  ? { clientAddress: string | null }
  : { clientAddress?: string | null });

export type Caller =
  | { kind: 'service'; workload: string }
  | {
      kind: 'user';
      subject: string;
      clientId: string;
      org: string | null;
      sessionId: string | null;
      actor: Actor | null;
    }
  | { kind: 'pat'; subject: string; patId: string; org: string | null };

export type VerifySuccess =
  | {
      ok: true;
      credential: 'access_token';
      issuerKind: IssuerKind;
      claims: AccessTokenClaims;
      caller: Caller;
    }
  | { ok: true; credential: 'pat'; issuerKind: 'uts'; pat: PatRecord; caller: Caller };

export type VerifyResult = VerifySuccess | VerifyFailure;

export type Verifier<RequireAddress extends boolean = true> = {
  /**
   * Checks the bearer credential of `input` (a request or its `Authorization` header value)
   * against `route`. Never throws for a bad credential or an unavailable dependency; it rejects
   * only for a route this verifier cannot serve (a programming error).
   */
  verify(
    input: Request | string | null,
    route: Route,
    ctx: VerifyContext<RequireAddress>
  ): Promise<VerifyResult>;
  /**
   * Starts the cold-start fetches (the UTS bootstrap, or the UTS key set without one, and the STS
   * key set) in parallel under `ctx.waitUntil`, without waiting for them. Call it at the start of a
   * request, beside the secrets bundle call; a later `verify` joins the fetches in flight.
   */
  warm(ctx: { waitUntil: WaitUntil }): void;
};

/** An issuer URL: `https:`, or `http:` on a loopback host for local development. */
const IssuerUrlSchema = z.url().refine(value => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  );
}, 'must be https, or http on localhost');

const ConfigSchema = z.object({
  audience: AudienceSchema,
  environment: StsEnvironmentSchema,
  resourceMetadataUrl: z.url().refine(url => !/["\\]/.test(url), 'must not contain quotes'),
  sts: z.object({ issuer: IssuerUrlSchema }).optional(),
  uts: z.object({ issuer: IssuerUrlSchema }).optional(),
});

/**
 * The longest `Authorization` value the verifier parses. A longer one is refused before any
 * split, base64 decode or JSON parse; every Kilo credential is far shorter.
 */
export const MAX_AUTHORIZATION_LENGTH = 8_192;

const BEARER = /^Bearer +([^\s]+) *$/i;

/** Maps the first schema issue to the §7 row it breaks. */
function claimsReason(error: z.ZodError): FailureReason {
  const field = error.issues[0]?.path[0];
  switch (field) {
    case 'sub':
    case 'jti':
    case 'client_id':
      return 'identity';
    case 'aud':
      return 'audience';
    case 'iss':
      return 'issuer';
    case 'exp':
    case 'iat':
    case 'nbf':
      return 'time';
    default:
      return 'claims';
  }
}

type StsIssuer = {
  kind: 'sts';
  issuer: string;
  keySet: KeySetCache;
  scopeRegistry: StsScopeRegistry;
};

type UtsIssuer = {
  kind: 'uts';
  issuer: string;
  keySet: KeySetCache;
  scopeRegistry: UtsScopeRegistry;
  feed: RevocationFeed;
  bootstrap: Bootstrap | null;
  pats: PatResolver | null;
};

/**
 * One verifier per isolate: create it at module scope so its caches are shared by every request.
 * It does no I/O until the first `warm` or `verify`.
 */
export function createVerifier<C extends VerifierConfig>(config: C): Verifier<AcceptsPats<C>> {
  ConfigSchema.parse(config);
  const audience = config.audience;
  const environment = config.environment;
  const failures = createFailures(config.resourceMetadataUrl);
  const sts: StsIssuer | null =
    config.sts === undefined
      ? null
      : {
          kind: 'sts',
          issuer: config.sts.issuer,
          keySet: createKeySetCache(config.sts.jwks, 'sts'),
          scopeRegistry: config.sts.scopeRegistry ?? STS_SCOPE_REGISTRY,
        };
  const uts: UtsIssuer | null = (() => {
    if (config.uts === undefined) return null;
    const keySet = createKeySetCache(config.uts.jwks, 'uts');
    const feed = createRevocationFeed(config.uts.revocation, (kid, now) =>
      keySet.feedKey(kid, now)
    );
    return {
      kind: 'uts',
      issuer: config.uts.issuer,
      keySet,
      scopeRegistry: config.uts.scopeRegistry,
      feed,
      bootstrap:
        config.uts.bootstrap === undefined
          ? null
          : createBootstrap(config.uts.bootstrap, keySet, feed),
      pats: config.uts.pat === undefined ? null : createPatResolver(config.uts.pat),
    };
  })();

  function assertRoute(route: Route): void {
    if (!ScopeSchema.safeParse(route.scope).success || scopeAudience(route.scope) !== audience) {
      throw new Error(`route scope ${route.scope} is not a scope of audience ${audience}`);
    }
    if ((route.issuer === 'sts' ? sts : uts) === null) {
      throw new Error(
        `route accepts ${route.issuer} tokens, but the verifier has no ${route.issuer} issuer`
      );
    }
    if (route.issuer === 'sts' && route.requiresSession === true) {
      throw new Error('an STS route cannot require a session: STS tokens carry none');
    }
    if (route.issuer === 'sts' && route.org !== undefined) {
      throw new Error('an STS route cannot be org-scoped: STS tokens carry no org');
    }
  }

  /** Cold UTS state with a bootstrap port: one bootstrap call fills the key set and the feed. */
  async function utsLoaded(issuer: UtsIssuer, scope: CallScope): Promise<VerifyFailure | null> {
    if (issuer.bootstrap === null) return null;
    const loaded = await issuer.bootstrap.load(scope);
    return loaded.status === 'ready'
      ? null
      : failures.unavailable('bootstrap_unavailable', loaded.retryAfterSeconds);
  }

  /**
   * Rows 1, 2, 3, 5 and 14 for either issuer: header, issuer, key and signature. The token is
   * decoded once; the payload returned is the one the signature covers, not yet validated.
   */
  async function verifySignedToken(
    token: string,
    issuer: StsIssuer | UtsIssuer,
    other: string | null,
    scope: CallScope
  ): Promise<{ ok: true; kid: string; payload: unknown } | VerifyFailure> {
    const jws = decodeJws(token);
    if (jws === null) return failures.invalidToken('malformed_token');
    const header = jws.header;
    if (hasJwsExtension(header)) return failures.invalidToken('header_extension');
    // Rows 1 and 5: EdDSA with a kid, typ at+jwt.
    if (header.alg !== ACCESS_TOKEN_ALGORITHM) return failures.invalidToken('algorithm');
    const kid = header.kid;
    if (typeof kid !== 'string' || kid === '') return failures.invalidToken('kid_missing');
    if (header.typ !== ACCESS_TOKEN_TYPE) return failures.invalidToken('type');

    // Rows 3 and 14: the route's one issuer; the key comes only from that issuer's set.
    const payload = jws.payload;
    const iss =
      typeof payload === 'object' && payload !== null && 'iss' in payload ? payload.iss : undefined;
    if (iss !== issuer.issuer) {
      return failures.invalidToken(other !== null && iss === other ? 'issuer_per_route' : 'issuer');
    }
    // A feed key never verifies a token, and a UTS token key carries the token prefix.
    if (
      kid.startsWith(UTS_FEED_KID_PREFIX) ||
      (issuer.kind === 'uts' && !kid.startsWith(UTS_TOKEN_KID_PREFIX))
    ) {
      return failures.invalidToken('not_token_key');
    }
    const found = await issuer.keySet.key(kid, scope);
    if (found.status === 'unknown_kid') return failures.invalidToken('unknown_kid');
    if (found.status === 'unavailable') {
      return failures.unavailable('jwks_unavailable', found.retryAfterSeconds);
    }

    // Row 2: the signature, Ed25519 only.
    if (!(await verifyEd25519(found.key, jws))) return failures.invalidToken('signature');
    return { ok: true, kid, payload };
  }

  /**
   * Row 6: a positive lifetime (`exp` after `iat` and after any `nbf`), then `exp` in the future,
   * `iat` and `nbf` not in the future, with 60 s of skew.
   */
  function timeFailure(claims: AccessTokenClaims): VerifyFailure | null {
    if (claims.exp <= claims.iat || (claims.nbf !== undefined && claims.nbf >= claims.exp)) {
      return failures.invalidToken('time');
    }
    const now = Date.now() / 1000;
    if (claims.exp <= now - TOKEN_CLOCK_SKEW_SECONDS) return failures.invalidToken('expired');
    if (claims.iat > now + TOKEN_CLOCK_SKEW_SECONDS)
      return failures.invalidToken('issued_in_future');
    if (claims.nbf !== undefined && claims.nbf > now + TOKEN_CLOCK_SKEW_SECONDS) {
      return failures.invalidToken('not_yet_valid');
    }
    return null;
  }

  /** Row 9: on an org-scoped route the credential names exactly the request org. */
  function orgMatches(route: Route, org: string | null | undefined): boolean {
    return route.org === undefined || org === route.org;
  }

  async function verifyStsToken(
    token: string,
    route: Route,
    issuer: StsIssuer,
    scope: CallScope
  ): Promise<VerifyResult> {
    const signed = await verifySignedToken(token, issuer, uts?.issuer ?? null, scope);
    if (!signed.ok) return signed;
    // Rows 4 (one string aud) and 7 (identity), plus the STS service-token profile.
    const parsed = ServiceTokenClaimsSchema.safeParse(signed.payload);
    if (!parsed.success) return failures.invalidToken(claimsReason(parsed.error));
    const claims = parsed.data;
    // Row 3 on the verified claims, and the environment this service runs in.
    if (claims.iss !== issuer.issuer) return failures.invalidToken('issuer');
    if (claims.env !== environment) return failures.invalidToken('environment');
    const late = timeFailure(claims);
    if (late !== null) return late;

    // Rows 4 and 8: this audience, a scope STS policy lists for it, the route's scope.
    if (claims.aud !== audience) return failures.insufficientScope('audience', route.scope);
    if (!isRegisteredStsScope(audience, claims.scope, issuer.scopeRegistry)) {
      return failures.insufficientScope('scope_unknown', route.scope);
    }
    if (claims.scope !== route.scope)
      return failures.insufficientScope('scope_mismatch', route.scope);

    // Rows 10, 11 and 13 do not apply: STS tokens name service subjects and are expiry-bound
    // (decision Q4); row 9 does not apply, as an STS route cannot be org-scoped.
    return {
      ok: true,
      credential: 'access_token',
      issuerKind: 'sts',
      claims,
      caller: { kind: 'service', workload: claims.client_id },
    };
  }

  async function verifyUtsToken(
    token: string,
    route: Route,
    issuer: UtsIssuer,
    scope: CallScope
  ): Promise<VerifyResult> {
    const cold = await utsLoaded(issuer, scope);
    if (cold !== null) return cold;
    const signed = await verifySignedToken(token, issuer, sts?.issuer ?? null, scope);
    if (!signed.ok) return signed;
    const parsed = AccessTokenClaimsSchema.safeParse(signed.payload);
    if (!parsed.success) return failures.invalidToken(claimsReason(parsed.error));
    const claims = parsed.data;
    // Row 3 on the verified claims, and the environment this service runs in.
    if (claims.iss !== issuer.issuer) return failures.invalidToken('issuer');
    if (claims.env !== environment) return failures.invalidToken('environment');
    const late = timeFailure(claims);
    if (late !== null) return late;

    // Rows 4 and 8: this audience, a scope the UTS registry lists for it, the route's scope.
    if (claims.aud !== audience) return failures.insufficientScope('audience', route.scope);
    const entry = issuer.scopeRegistry(audience, claims.scope);
    if (entry === null) return failures.insufficientScope('scope_unknown', route.scope);
    if (claims.scope !== route.scope)
      return failures.insufficientScope('scope_mismatch', route.scope);

    // Row 11: a session-bound route or scope needs a session id.
    if ((route.requiresSession === true || entry.requiresSession) && claims.sid === undefined) {
      return failures.invalidToken('session_required');
    }

    // Rows 10, 11 and 13 against the feed, with the head-age limit for this token's lifetime.
    const read = await issuer.feed.read(maxHeadAgeForLifetime(claims.exp - claims.iat), scope);
    if (read.status === 'unavailable') {
      return failures.unavailable('feed_unavailable', read.retryAfterSeconds);
    }
    const list = read.list;
    const revokedBefore = list.revokedBefore.get(claims.sub);
    if (revokedBefore !== undefined && claims.iat <= revokedBefore) {
      return failures.invalidToken('revoked_subject');
    }
    if (claims.sid !== undefined && list.revokedSids.has(claims.sid)) {
      return failures.invalidToken('revoked_session');
    }
    if (list.revokedKids.has(signed.kid)) return failures.invalidToken('revoked_kid');
    if (list.blockedAccounts.has(claims.sub)) return failures.invalidToken('blocked_account');
    // Row 9 after the feed, as on the PAT path: a revoked token gets 401 whatever its org.
    if (!orgMatches(route, claims.org)) return failures.orgMismatch();

    return {
      ok: true,
      credential: 'access_token',
      issuerKind: 'uts',
      claims,
      caller: {
        kind: 'user',
        subject: claims.sub,
        clientId: claims.client_id,
        org: claims.org ?? null,
        sessionId: claims.sid ?? null,
        actor: claims.act ?? null,
      },
    };
  }

  async function verifyPat(
    token: string,
    route: Route,
    issuer: UtsIssuer,
    ctx: VerifyContext<boolean>,
    scope: CallScope
  ): Promise<VerifyResult> {
    const pats = issuer.pats;
    if (pats === null) return failures.invalidToken('pat_not_accepted');
    // Row 12: offline prefix and checksum first; a malformed PAT touches no cache and no feed.
    const parsed = parsePat(token);
    if (!parsed.ok) return failures.invalidToken('pat_malformed');
    // The per-address lookup limit needs an address; there is no shared fallback bucket.
    const clientAddress = ctx.clientAddress;
    if (typeof clientAddress !== 'string' || clientAddress === '') {
      return failures.invalidRequest('pat_client_address_missing');
    }
    const request: PatRequest = { clientAddress, waitUntil: ctx.waitUntil, scope };
    // The hash and the shared-cache read run alongside the key-set and feed reads.
    const prepared = hashPat(parsed.pat).then(hash => ({
      hash,
      shared: pats.prefetch(hash, request),
    }));

    const cold = await utsLoaded(issuer, scope);
    if (cold !== null) return cold;
    // The feed head verifies under a feed key of the UTS key set.
    const keys = await issuer.keySet.ready(scope);
    if (keys.status === 'unavailable') {
      return failures.unavailable('jwks_unavailable', keys.retryAfterSeconds);
    }
    // A PAT is a long-lived credential: the feed head must be at most 60 s old, even on a cache hit.
    // This read fails fast before any lookup; the decision below reads the feed again.
    const early = await issuer.feed.read(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS, scope);
    if (early.status === 'unavailable') {
      return failures.unavailable('feed_unavailable', early.retryAfterSeconds);
    }
    const { hash, shared } = await prepared;
    const resolved = await pats.resolve(hash, request, shared);
    switch (resolved.status) {
      case 'rate_limited':
        return failures.rateLimited(resolved.retryAfterSeconds);
      case 'unavailable':
        return failures.unavailable('pat_lookup_unavailable', resolved.retryAfterSeconds);
      case 'not_found':
        return failures.invalidToken('pat_not_found');
      case 'found':
        break;
    }
    const record = resolved.record;
    // The shared-cache read or the lookup may have waited: decide on the feed as it is now, so a
    // revocation installed meanwhile counts and the head is still at most 60 s old.
    const read = await issuer.feed.read(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS, scope);
    if (read.status === 'unavailable') {
      return failures.unavailable('feed_unavailable', read.retryAfterSeconds);
    }
    // The feed entry for this PAT id overrides every cache layer; rows 13 and the PAT's own expiry.
    if (read.list.revokedPatIds.has(record.patId)) {
      pats.forget(hash);
      return failures.invalidToken('pat_revoked');
    }
    if (read.list.blockedAccounts.has(record.subject))
      return failures.invalidToken('blocked_account');
    if (record.expiresAt <= Date.now() / 1000) return failures.invalidToken('pat_expired');

    // Rows 4, 8, 9 and 11 for the PAT's one audience and one scope.
    if (record.audience !== audience) return failures.insufficientScope('audience', route.scope);
    const entry = issuer.scopeRegistry(audience, record.scope);
    if (entry === null) return failures.insufficientScope('scope_unknown', route.scope);
    if (!entry.patEligible) return failures.insufficientScope('pat_not_eligible', route.scope);
    if (record.scope !== route.scope)
      return failures.insufficientScope('scope_mismatch', route.scope);
    if (!orgMatches(route, record.org)) return failures.orgMismatch();
    // A PAT names no session, so a session-bound route or scope refuses it.
    if (route.requiresSession === true || entry.requiresSession) {
      return failures.invalidToken('session_required');
    }
    return {
      ok: true,
      credential: 'pat',
      issuerKind: 'uts',
      pat: record,
      caller: { kind: 'pat', subject: record.subject, patId: record.patId, org: record.org },
    };
  }

  function dispatch(
    token: string,
    route: Route,
    ctx: VerifyContext<boolean>,
    scope: CallScope
  ): Promise<VerifyResult> {
    if (route.issuer === 'sts') {
      if (sts === null) throw new Error('unreachable: assertRoute checked the STS issuer');
      // Row 14: a PAT is a UTS credential.
      if (hasPatPrefix(token)) return Promise.resolve(failures.invalidToken('issuer_per_route'));
      return verifyStsToken(token, route, sts, scope);
    }
    if (uts === null) throw new Error('unreachable: assertRoute checked the UTS issuer');
    return hasPatPrefix(token)
      ? verifyPat(token, route, uts, ctx, scope)
      : verifyUtsToken(token, route, uts, scope);
  }

  return {
    async verify(input, route, ctx) {
      assertRoute(route);
      const authorization =
        typeof input === 'string' || input === null ? input : input.headers.get('authorization');
      if (authorization === null || authorization.trim() === '') {
        return failures.missingCredential();
      }
      if (authorization.length > MAX_AUTHORIZATION_LENGTH) {
        return failures.invalidToken('credential_too_long');
      }
      const match = BEARER.exec(authorization);
      if (match === null) {
        return /^Bearer\b/i.test(authorization)
          ? failures.invalidToken('malformed_token')
          : failures.missingCredential();
      }
      const token = match[1] ?? '';
      const scope = newCallScope();
      try {
        return await dispatch(token, route, ctx, scope);
      } finally {
        handOff(scope, ctx.waitUntil);
      }
    },
    warm(ctx) {
      const scope = newCallScope();
      sts?.keySet.prefetch(scope);
      if (uts !== null) {
        if (uts.bootstrap !== null) uts.bootstrap.prefetch(scope);
        else uts.keySet.prefetch(scope);
      }
      handOff(scope, ctx.waitUntil);
    },
  };
}
