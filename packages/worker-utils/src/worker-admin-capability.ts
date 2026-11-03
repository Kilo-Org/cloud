import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { z } from 'zod';
import { bytesToBase64url } from './base64url';
import {
  WORKER_ADMIN_ACTIONS,
  WORKER_ADMIN_AUDIENCES,
  WORKER_ADMIN_TARGET_KINDS,
  capabilityActionAccess,
  findWorkerAdminAction,
  workerAdminServiceTarget,
  type WorkerAdminAudience,
} from './worker-admin-actions';

export {
  GASTOWN_ADMIN_AUDIENCE,
  WASTELAND_ADMIN_AUDIENCE,
  WORKER_ADMIN_ACTIONS,
  WORKER_ADMIN_AUDIENCES,
  WORKER_ADMIN_TARGET_KINDS,
  capabilityActionAccess,
  findWorkerAdminAction,
  workerAdminServiceTarget,
} from './worker-admin-actions';
export type {
  WorkerAdminAction,
  WorkerAdminActionAccess,
  WorkerAdminAudience,
  WorkerAdminTargetKind,
} from './worker-admin-actions';

/**
 * Worker admin capability tokens.
 *
 * A capability is a short-lived ES256 JWT, separate from the ordinary Kilo
 * identity token, that names the exact admin actions and targets a web request
 * may exercise on a Worker. Workers verify it locally (public JWKS) and then
 * introspect it online before granting access.
 */

export const WORKER_ADMIN_CAPABILITY_HEADER = 'X-Kilo-Worker-Capability';
export const WORKER_ADMIN_CAPABILITY_TYP = 'kilo-worker-cap+jwt';
export const WORKER_ADMIN_CAPABILITY_ISSUER = 'kilo-web';
export const WORKER_ADMIN_CAPABILITY_VERSION = 1;
export const BROWSER_CAPABILITY_TTL_SECONDS = 300;
export const SERVER_CAPABILITY_TTL_SECONDS = 60;
export const WORKER_ADMIN_CAPABILITY_MAX_TTL_SECONDS = 300;
export const WORKER_ADMIN_CAPABILITY_CLOCK_TOLERANCE_SECONDS = 30;
export const WORKER_ADMIN_READ_INTROSPECTION_CACHE_MS = 15_000;
export const LEGACY_ADMIN_CLAIM_MAX_LIFETIME_SECONDS = 3600;

export const LEGACY_ADMIN_CLAIM_MODES = ['honor', 'observe', 'reject'] as const;
export type LegacyAdminClaimMode = (typeof LEGACY_ADMIN_CLAIM_MODES)[number];
export const DEFAULT_LEGACY_ADMIN_CLAIM_MODE: LegacyAdminClaimMode = 'honor';

export function parseLegacyAdminClaimMode(value: unknown): LegacyAdminClaimMode {
  return z.enum(LEGACY_ADMIN_CLAIM_MODES).safeParse(value).data ?? DEFAULT_LEGACY_ADMIN_CLAIM_MODE;
}

export const WorkerAdminTargetKindSchema = z.enum(WORKER_ADMIN_TARGET_KINDS);

export const WorkerAdminTargetSchema = z
  .object({ kind: WorkerAdminTargetKindSchema, id: z.string().min(1).max(200) })
  .strict();

export type WorkerAdminTarget = z.infer<typeof WorkerAdminTargetSchema>;

export const WorkerAdminCapabilityClaimsSchema = z
  .object({
    iss: z.literal(WORKER_ADMIN_CAPABILITY_ISSUER),
    sub: z.string().min(1),
    aud: z.enum(WORKER_ADMIN_AUDIENCES),
    env: z.string().optional(),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    jti: z.string().min(1).max(200),
    cap: z
      .object({
        v: z.literal(WORKER_ADMIN_CAPABILITY_VERSION),
        actions: z.array(z.string().min(1).max(200)).min(1).max(64),
        targets: z.array(WorkerAdminTargetSchema).min(1).max(16),
      })
      .strict(),
    bnd: z
      .object({
        pep: z.string(),
        wsp: z.string(),
      })
      .strict(),
  })
  .strict();

export type WorkerAdminCapabilityClaims = z.infer<typeof WorkerAdminCapabilityClaimsSchema>;

export type WorkerAdminCapabilityActionCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'action_not_allowed'
        | 'target_mismatch'
        | 'service_target_mismatch'
        | 'target_kind_mismatch';
    };

export function capabilityAllowsAction(
  audience: WorkerAdminAudience,
  claims: WorkerAdminCapabilityClaims,
  actionId: string,
  target: WorkerAdminTarget
): WorkerAdminCapabilityActionCheck {
  const entry = findWorkerAdminAction(audience, actionId);
  if (!entry || !claims.cap.actions.includes(actionId)) {
    return { allowed: false, reason: 'action_not_allowed' };
  }
  const candidates = claims.cap.targets.filter(candidate => candidate.kind === entry.targetKind);
  if (candidates.length === 0) {
    return { allowed: false, reason: 'target_kind_mismatch' };
  }
  if (entry.targetKind === 'service') {
    const expected = workerAdminServiceTarget(audience).id;
    return target.id === expected && candidates.some(candidate => candidate.id === expected)
      ? { allowed: true }
      : { allowed: false, reason: 'service_target_mismatch' };
  }
  return candidates.some(candidate => candidate.id === target.id)
    ? { allowed: true }
    : { allowed: false, reason: 'target_mismatch' };
}

function matchesRoutePattern(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = pathname.split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) => {
    if (segment.startsWith(':')) return (pathSegments[index] ?? '') !== '';
    return segment === pathSegments[index];
  });
}

/**
 * Resolve a REST request to a capability action id without relying on the
 * router's matched-route bookkeeping, which middleware can observe differently
 * from the final handler. Returns the first reviewed allowlist entry that
 * matches the method and concrete path.
 */
export function matchWorkerAdminRestAction(
  audience: WorkerAdminAudience,
  method: string,
  pathname: string
): string | null {
  const normalizedMethod = method.toUpperCase();
  for (const actionId of Object.keys(WORKER_ADMIN_ACTIONS[audience])) {
    if (!actionId.startsWith('rest:')) continue;
    const [allowedMethod, pattern] = actionId.slice('rest:'.length).split(' ', 2);
    if (allowedMethod !== normalizedMethod || pattern === undefined) continue;
    if (matchesRoutePattern(pattern, pathname)) return actionId;
  }
  return null;
}

/** b64url(sha256(value)) used for the `bnd` claim. */
export async function workerAdminBindingDigest(value: string | null | undefined): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value ?? ''));
  return bytesToBase64url(new Uint8Array(digest));
}

export type WorkerAdminIdentity = {
  kiloUserId: string;
  apiTokenPepper: string | null;
  env: string | undefined;
};

export type LegacyAdminClaim = {
  isAdmin: unknown;
  iat: unknown;
  exp: unknown;
};

export type LegacyAdminClaimResult =
  | { allowed: true }
  | { allowed: false; reason: 'not_admin' | 'missing_exp' | 'lifetime_exceeded' };

/**
 * Lifetime hardening applied to every legacy `isAdmin` claim, in every mode.
 * A legacy elevation must carry `exp` and live at most one hour; no live issuer
 * exceeds that bound.
 */
export function evaluateLegacyAdminClaim(claims: LegacyAdminClaim): LegacyAdminClaimResult {
  if (claims.isAdmin !== true) return { allowed: false, reason: 'not_admin' };
  if (typeof claims.exp !== 'number') return { allowed: false, reason: 'missing_exp' };
  if (typeof claims.iat !== 'number') return { allowed: false, reason: 'missing_exp' };
  if (claims.exp - claims.iat > LEGACY_ADMIN_CLAIM_MAX_LIFETIME_SECONDS) {
    return { allowed: false, reason: 'lifetime_exceeded' };
  }
  return { allowed: true };
}

export type WorkerAdminIntrospectionRequest = {
  jti: string;
  sub: string;
  aud: WorkerAdminAudience;
  action: string;
  target: WorkerAdminTarget;
  bnd: { pep: string; wsp: string };
};

export type WorkerAdminIntrospectionResponse = { active: boolean; reason?: string };

export type WorkerAdminIntrospect = (
  request: WorkerAdminIntrospectionRequest
) => Promise<WorkerAdminIntrospectionResponse>;

const IntrospectionResponseSchema = z
  .object({ active: z.boolean(), reason: z.string().optional() })
  .passthrough();

/** HTTP client for the web introspection endpoint; throws on any non-2xx. */
export function createWorkerAdminIntrospection(params: {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): WorkerAdminIntrospect {
  const fetchImpl = params.fetchImpl ?? fetch;
  return async request => {
    const response = await fetchImpl(params.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': params.secret,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Worker admin capability introspection failed: ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    return IntrospectionResponseSchema.parse(body);
  };
}

export type WorkerAdminDecisionFailureReason =
  | 'capability_invalid'
  | 'capability_missing'
  | 'action_not_allowed'
  | 'target_mismatch'
  | 'target_kind_mismatch'
  | 'service_target_mismatch'
  | 'role_revoked'
  | 'blocked'
  | 'session_revoked'
  | 'expired'
  | 'validation_unavailable'
  | 'legacy_claim_rejected'
  | 'legacy_claim_missing_exp'
  | 'legacy_claim_lifetime_rejected';

export type WorkerAdminDecision =
  | {
      allowed: true;
      source: 'capability' | 'legacy';
      wouldDeny: boolean;
      jti: string | null;
      reason: string | null;
    }
  | {
      allowed: false;
      source: 'capability' | 'legacy' | 'none';
      status: 401 | 403 | 503;
      reason: WorkerAdminDecisionFailureReason;
    };

export type WorkerAdminAuthority = {
  mode: LegacyAdminClaimMode;
  audience: WorkerAdminAudience;
  legacyClaim: boolean;
  legacyClaimRejection: 'not_admin' | 'missing_exp' | 'lifetime_exceeded' | null;
  hasCapability: boolean;
  capabilityError: string | null;
  capabilityJti: string | null;
  decide(actionId: string, target: WorkerAdminTarget): Promise<WorkerAdminDecision>;
  allows(actionId: string, target: WorkerAdminTarget): Promise<boolean>;
  /** First call for an action/target returns true; later ones return false. */
  takeDecisionReport(actionId: string, target: WorkerAdminTarget): boolean;
};

export type WorkerAdminIntrospectionCache = {
  get(key: string): WorkerAdminIntrospectionResponse | undefined;
  set(key: string, value: WorkerAdminIntrospectionResponse, ttlMs: number): void;
};

const MAX_INTROSPECTION_CACHE_ENTRIES = 500;

export function createWorkerAdminIntrospectionCache(): WorkerAdminIntrospectionCache {
  const entries = new Map<string, { value: WorkerAdminIntrospectionResponse; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (entries.size <= MAX_INTROSPECTION_CACHE_ENTRIES) return;
      const now = Date.now();
      for (const [candidate, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(candidate);
      }
      while (entries.size > MAX_INTROSPECTION_CACHE_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

export function readWorkerAdminCapabilityHeader(headers: Headers): string | null {
  const value = headers.get(WORKER_ADMIN_CAPABILITY_HEADER);
  return value === null || value.trim() === '' ? null : value.trim();
}

export const WorkerAdminJwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).min(1),
});

export type WorkerAdminJwks = z.infer<typeof WorkerAdminJwksSchema>;

export function parseWorkerAdminJwks(value: unknown): WorkerAdminJwks | null {
  if (value === null || value === undefined || value === '') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const result = WorkerAdminJwksSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

type ImportedJoseKey = Awaited<ReturnType<typeof importJWK>>;

const importedKeyCache = new Map<string, ImportedJoseKey>();

async function importWorkerAdminKey(jwk: Record<string, unknown>): Promise<ImportedJoseKey> {
  const keyId = JSON.stringify(jwk);
  const cached = importedKeyCache.get(keyId);
  if (cached) return cached;
  const key = await importJWK(jwk as JWK, 'ES256');
  importedKeyCache.set(keyId, key);
  return key;
}

export type VerifyWorkerAdminCapabilityParams = {
  token: string;
  jwks: WorkerAdminJwks | null;
  audience: WorkerAdminAudience;
  identity: WorkerAdminIdentity;
  now?: () => number;
};

export type WorkerAdminCapabilityVerification =
  | { ok: true; claims: WorkerAdminCapabilityClaims }
  | { ok: false; reason: string };

export async function verifyWorkerAdminCapability(
  params: VerifyWorkerAdminCapabilityParams
): Promise<WorkerAdminCapabilityVerification> {
  if (!params.jwks) return { ok: false, reason: 'keys_unavailable' };
  const nowSeconds = Math.floor((params.now?.() ?? Date.now()) / 1000);
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  try {
    header = decodeProtectedHeader(params.token);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'ES256') return { ok: false, reason: 'algorithm' };
  if (header.typ !== WORKER_ADMIN_CAPABILITY_TYP) return { ok: false, reason: 'type' };
  if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'kid' };

  const jwk = params.jwks.keys.find(candidate => candidate.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };

  let payload: unknown;
  try {
    const key = await importWorkerAdminKey(jwk);
    const verified = await jwtVerify(params.token, key, {
      algorithms: ['ES256'],
      audience: params.audience,
      issuer: WORKER_ADMIN_CAPABILITY_ISSUER,
      clockTolerance: WORKER_ADMIN_CAPABILITY_CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(nowSeconds * 1000),
    });
    payload = verified.payload;
  } catch {
    return { ok: false, reason: 'signature' };
  }

  const parsed = WorkerAdminCapabilityClaimsSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: 'claims' };
  const claims = parsed.data;

  if (claims.exp <= claims.iat) return { ok: false, reason: 'lifetime' };
  if (claims.exp - claims.iat > WORKER_ADMIN_CAPABILITY_MAX_TTL_SECONDS) {
    return { ok: false, reason: 'lifetime' };
  }
  if (claims.nbf > nowSeconds + WORKER_ADMIN_CAPABILITY_CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (claims.iat > nowSeconds + WORKER_ADMIN_CAPABILITY_CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'issued_in_future' };
  }
  if (claims.sub !== params.identity.kiloUserId) return { ok: false, reason: 'subject' };
  if (claims.env !== params.identity.env) return { ok: false, reason: 'environment' };
  const expectedPepper = await workerAdminBindingDigest(params.identity.apiTokenPepper);
  if (claims.bnd.pep !== expectedPepper) return { ok: false, reason: 'binding' };

  return { ok: true, claims };
}

export type CreateWorkerAdminAuthorityParams = {
  mode: LegacyAdminClaimMode;
  audience: WorkerAdminAudience;
  identity: WorkerAdminIdentity;
  legacyClaim: boolean;
  legacyClaimRejection?: 'not_admin' | 'missing_exp' | 'lifetime_exceeded' | null;
  capabilityToken: string | null;
  jwks: WorkerAdminJwks | null;
  introspect: WorkerAdminIntrospect;
  readCache?: WorkerAdminIntrospectionCache;
  now?: () => number;
};

export async function createWorkerAdminAuthority(
  params: CreateWorkerAdminAuthorityParams
): Promise<WorkerAdminAuthority> {
  const legacyClaim = params.legacyClaim;
  let capability: WorkerAdminCapabilityClaims | null = null;
  let capabilityError: string | null = null;

  if (params.capabilityToken !== null) {
    const verification = await verifyWorkerAdminCapability({
      token: params.capabilityToken,
      jwks: params.jwks,
      audience: params.audience,
      identity: params.identity,
      now: params.now,
    });
    if (verification.ok) {
      capability = verification.claims;
    } else {
      capabilityError = verification.reason;
    }
  }

  const decisionMemo = new Map<string, Promise<WorkerAdminDecision>>();
  const introspectionMemo = new Map<string, Promise<WorkerAdminIntrospectionResponse>>();
  const reported = new Set<string>();

  async function introspectOnce(
    claims: WorkerAdminCapabilityClaims,
    actionId: string,
    target: WorkerAdminTarget
  ): Promise<WorkerAdminIntrospectionResponse> {
    const cacheKey = `${claims.jti}\u0000${actionId}\u0000${target.kind}\u0000${target.id}`;
    const access = capabilityActionAccess(params.audience, actionId);
    if (access === 'read' && params.readCache) {
      const cached = params.readCache.get(cacheKey);
      if (cached) return cached;
    }
    let pending = introspectionMemo.get(cacheKey);
    if (!pending) {
      pending = params.introspect({
        jti: claims.jti,
        sub: claims.sub,
        aud: claims.aud,
        action: actionId,
        target,
        bnd: claims.bnd,
      });
      introspectionMemo.set(cacheKey, pending);
    }
    const result = await pending;
    if (access === 'read' && params.readCache && result.active) {
      params.readCache.set(cacheKey, result, WORKER_ADMIN_READ_INTROSPECTION_CACHE_MS);
    }
    return result;
  }

  async function decideCapability(
    claims: WorkerAdminCapabilityClaims,
    actionId: string,
    target: WorkerAdminTarget
  ): Promise<WorkerAdminDecision> {
    const check = capabilityAllowsAction(params.audience, claims, actionId, target);
    if (!check.allowed) {
      return { allowed: false, source: 'capability', status: 403, reason: check.reason };
    }
    let introspection: WorkerAdminIntrospectionResponse;
    try {
      introspection = await introspectOnce(claims, actionId, target);
    } catch {
      return {
        allowed: false,
        source: 'capability',
        status: 503,
        reason: 'validation_unavailable',
      };
    }
    if (!introspection.active) {
      const reason = introspection.reason;
      if (
        reason === 'role_revoked' ||
        reason === 'blocked' ||
        reason === 'session_revoked' ||
        reason === 'expired'
      ) {
        return { allowed: false, source: 'capability', status: 403, reason };
      }
      return {
        allowed: false,
        source: 'capability',
        status: 403,
        reason: 'validation_unavailable',
      };
    }
    return {
      allowed: true,
      source: 'capability',
      wouldDeny: false,
      jti: claims.jti,
      reason: 'granted',
    };
  }

  function decideLegacy(): WorkerAdminDecision {
    if (!legacyClaim) {
      if (params.legacyClaimRejection === 'missing_exp') {
        return {
          allowed: false,
          source: 'legacy',
          status: 401,
          reason: 'legacy_claim_missing_exp',
        };
      }
      if (params.legacyClaimRejection === 'lifetime_exceeded') {
        return {
          allowed: false,
          source: 'legacy',
          status: 401,
          reason: 'legacy_claim_lifetime_rejected',
        };
      }
      return { allowed: false, source: 'none', status: 403, reason: 'legacy_claim_rejected' };
    }
    if (params.mode === 'reject') {
      return { allowed: false, source: 'legacy', status: 403, reason: 'legacy_claim_rejected' };
    }
    return {
      allowed: true,
      source: 'legacy',
      wouldDeny: params.mode === 'observe',
      jti: null,
      reason: params.mode === 'observe' ? 'observe_would_deny' : 'honored',
    };
  }

  function decide(actionId: string, target: WorkerAdminTarget): Promise<WorkerAdminDecision> {
    const key = `${actionId}\u0000${target.kind}\u0000${target.id}`;
    let pending = decisionMemo.get(key);
    if (!pending) {
      let resolved: WorkerAdminDecision | Promise<WorkerAdminDecision>;
      if (capabilityError !== null) {
        resolved = {
          allowed: false,
          source: 'capability',
          status: 401,
          reason: 'capability_invalid',
        };
      } else if (capability !== null) {
        resolved = decideCapability(capability, actionId, target);
      } else {
        resolved = decideLegacy();
      }
      pending = Promise.resolve(resolved);
      decisionMemo.set(key, pending);
    }
    return pending;
  }

  return {
    mode: params.mode,
    audience: params.audience,
    legacyClaim,
    legacyClaimRejection: params.legacyClaimRejection ?? null,
    hasCapability: capability !== null,
    capabilityError,
    capabilityJti: capability?.jti ?? null,
    decide,
    async allows(actionId, target) {
      return (await decide(actionId, target)).allowed;
    },
    takeDecisionReport(actionId, target) {
      const key = `${actionId}\u0000${target.kind}\u0000${target.id}`;
      if (reported.has(key)) return false;
      reported.add(key);
      return true;
    },
  };
}
