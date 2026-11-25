import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TYPE,
  AccessTokenClaimsSchema,
  AudienceSchema,
  STS_SCOPE_REGISTRY,
  ScopeSchema,
  ServiceTokenClaimsSchema,
  TOKEN_CLOCK_SKEW_SECONDS,
  isRegisteredStsScope,
  scopeAudience,
  type AccessTokenClaims,
  type Actor,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import {
  compactVerify,
  decodeJwt,
  decodeProtectedHeader,
  type JWTPayload,
  type ProtectedHeaderParameters,
} from 'jose';
import { z } from 'zod';
import { createFailures, type FailureReason, type VerifyFailure } from './failure';
import { handOff, newCallScope, type CallScope, type WaitUntil } from './flight';
import { createKeySetCache, type JwksSource, type KeySetCache } from './jwks';
import { hashPat, hasPatPrefix, parsePat } from './pat-format';
import { createPatResolver, type PatConfig, type PatRecord, type PatResolver } from './pat';
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
  /** RFC 9728 protected-resource metadata URL, sent in every 401 challenge. */
  resourceMetadataUrl: string;
  sts?: {
    /** Exact `iss` of STS tokens, such as `STS_ISSUERS.production`. */
    issuer: string;
    jwks: JwksSource;
    /** Defaults to `STS_SCOPE_REGISTRY`. */
    scopeRegistry?: StsScopeRegistry;
  };
  uts?: {
    issuer: string;
    jwks: JwksSource;
    /**
     * Whether a `kid` names a token-signing key. The UTS key set also publishes the revocation-feed
     * keys (design 5.6); a token signed under any other `kid` is refused before any key-set fetch.
     */
    isTokenKid: (kid: string) => boolean;
    scopeRegistry: UtsScopeRegistry;
    revocation: RevocationFeedSource;
    /** Without it, a PAT is refused with 401. */
    pat?: PatConfig;
  };
};

/** What one route accepts: exactly one issuer and exactly one scope. */
export type Route = {
  issuer: IssuerKind;
  scope: string;
  /** The organization the request acts in, when the route is org-scoped. */
  org?: string;
  /** The route needs a live session (`sid`), whatever its scope's registry entry says; UTS only. */
  requiresSession?: boolean;
};

export type VerifyContext = {
  /** The request's own `waitUntil`; background refreshes this request starts run under it. */
  waitUntil: WaitUntil;
  /** The client's address, for the per-address PAT lookup limit. */
  clientAddress?: string;
};

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

export type Verifier = {
  /**
   * Checks the bearer credential of `input` (a request or its `Authorization` header value)
   * against `route`. Never throws for a bad credential or an unavailable dependency; it rejects
   * only for a route this verifier cannot serve (a programming error).
   */
  verify(input: Request | string | null, route: Route, ctx: VerifyContext): Promise<VerifyResult>;
};

const ConfigSchema = z.object({
  audience: AudienceSchema,
  resourceMetadataUrl: z.url().refine(url => !/["\\]/.test(url), 'must not contain quotes'),
});

const BEARER = /^Bearer +([^\s]+) *$/i;

/** The address bucket for requests whose caller passed none. */
const UNKNOWN_ADDRESS = 'unknown';

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

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

type StsIssuer = {
  issuer: string;
  keySet: KeySetCache;
  scopeRegistry: StsScopeRegistry;
};

type UtsIssuer = {
  issuer: string;
  keySet: KeySetCache;
  isTokenKid: (kid: string) => boolean;
  scopeRegistry: UtsScopeRegistry;
  feed: RevocationFeed;
  pats: PatResolver | null;
};

/**
 * One verifier per isolate: create it at module scope so its caches are shared by every request.
 * It does no I/O until the first `verify`.
 */
export function createVerifier(config: VerifierConfig): Verifier {
  ConfigSchema.parse(config);
  const audience = config.audience;
  const failures = createFailures(config.resourceMetadataUrl);
  const sts: StsIssuer | null =
    config.sts === undefined
      ? null
      : {
          issuer: config.sts.issuer,
          keySet: createKeySetCache(config.sts.jwks),
          scopeRegistry: config.sts.scopeRegistry ?? STS_SCOPE_REGISTRY,
        };
  const uts: UtsIssuer | null =
    config.uts === undefined
      ? null
      : {
          issuer: config.uts.issuer,
          keySet: createKeySetCache(config.uts.jwks),
          isTokenKid: config.uts.isTokenKid,
          scopeRegistry: config.uts.scopeRegistry,
          feed: createRevocationFeed(config.uts.revocation),
          pats: config.uts.pat === undefined ? null : createPatResolver(config.uts.pat),
        };

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
  }

  /** Rows 1-7 for either issuer: header, issuer, key, signature, claim types and time. */
  async function verifySignedToken(
    token: string,
    issuer: { issuer: string; keySet: KeySetCache; isTokenKid?: (kid: string) => boolean },
    other: string | null,
    scope: CallScope
  ): Promise<{ ok: true; kid: string; payload: unknown } | VerifyFailure> {
    if (token.split('.').length !== 3) return failures.invalidToken('malformed_token');
    let header: ProtectedHeaderParameters;
    let peeked: JWTPayload;
    try {
      header = decodeProtectedHeader(token);
      peeked = decodeJwt(token);
    } catch {
      return failures.invalidToken('malformed_token');
    }
    // Rows 1 and 5: EdDSA with a kid, typ at+jwt.
    if (header.alg !== ACCESS_TOKEN_ALGORITHM) return failures.invalidToken('algorithm');
    if (typeof header.kid !== 'string' || header.kid === '')
      return failures.invalidToken('kid_missing');
    if (header.typ !== ACCESS_TOKEN_TYPE) return failures.invalidToken('type');

    // Rows 3 and 14: the route's one issuer; the key comes only from that issuer's set.
    if (peeked.iss !== issuer.issuer) {
      return failures.invalidToken(
        other !== null && peeked.iss === other ? 'issuer_per_route' : 'issuer'
      );
    }
    if (issuer.isTokenKid !== undefined && !issuer.isTokenKid(header.kid)) {
      return failures.invalidToken('not_token_key');
    }
    const found = await issuer.keySet.key(header.kid, scope);
    if (found.status === 'unknown_kid') return failures.invalidToken('unknown_kid');
    if (found.status === 'unavailable') {
      return failures.unavailable('jwks_unavailable', found.retryAfterSeconds);
    }

    // Row 2: the signature, Ed25519 only.
    try {
      const verified = await compactVerify(token, found.key, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
      });
      return { ok: true, kid: header.kid, payload: parseJson(verified.payload) };
    } catch {
      return failures.invalidToken('signature');
    }
  }

  /** Row 6: `exp` in the future, `iat` and `nbf` not in the future, with 60 s of skew. */
  function timeFailure(claims: AccessTokenClaims): VerifyFailure | null {
    const now = Date.now() / 1000;
    if (claims.exp <= now - TOKEN_CLOCK_SKEW_SECONDS) return failures.invalidToken('expired');
    if (claims.iat > now + TOKEN_CLOCK_SKEW_SECONDS)
      return failures.invalidToken('issued_in_future');
    if (claims.nbf !== undefined && claims.nbf > now + TOKEN_CLOCK_SKEW_SECONDS) {
      return failures.invalidToken('not_yet_valid');
    }
    return null;
  }

  /** Row 9: a present org claim matches the request org on an org-scoped route. */
  function orgMatches(route: Route, org: string | null | undefined): boolean {
    return route.org === undefined || org === undefined || org === null || org === route.org;
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
    // (decision Q4); row 9 cannot fail, as the profile refuses an `org` claim.
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
    const signed = await verifySignedToken(token, issuer, sts?.issuer ?? null, scope);
    if (!signed.ok) return signed;
    const parsed = AccessTokenClaimsSchema.safeParse(signed.payload);
    if (!parsed.success) return failures.invalidToken(claimsReason(parsed.error));
    const claims = parsed.data;
    const late = timeFailure(claims);
    if (late !== null) return late;

    // Rows 4 and 8: this audience, a scope the UTS registry lists for it, the route's scope.
    if (claims.aud !== audience) return failures.insufficientScope('audience', route.scope);
    const entry = issuer.scopeRegistry(audience, claims.scope);
    if (entry === null) return failures.insufficientScope('scope_unknown', route.scope);
    if (claims.scope !== route.scope)
      return failures.insufficientScope('scope_mismatch', route.scope);
    if (!orgMatches(route, claims.org)) return failures.orgMismatch();

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
    ctx: VerifyContext,
    scope: CallScope
  ): Promise<VerifyResult> {
    if (issuer.pats === null) return failures.invalidToken('pat_not_accepted');
    // Row 12: offline prefix and checksum first; a malformed PAT touches no cache and no feed.
    const parsed = parsePat(token);
    if (!parsed.ok) return failures.invalidToken('pat_malformed');
    // A PAT is a long-lived credential: the feed head must be at most 60 s old, even on a cache hit.
    const read = await issuer.feed.read(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS, scope);
    if (read.status === 'unavailable') {
      return failures.unavailable('feed_unavailable', read.retryAfterSeconds);
    }
    const hash = await hashPat(parsed.pat);
    const resolved = await issuer.pats.resolve(hash, ctx.clientAddress ?? UNKNOWN_ADDRESS, scope);
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
    // The feed entry for this PAT id overrides every cache layer; rows 13 and the PAT's own expiry.
    if (read.list.revokedPatIds.has(record.patId)) {
      issuer.pats.forget(hash);
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
    ctx: VerifyContext,
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
  };
}
