import {
  cloudAgentWorktreeIdSchema,
  MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS,
} from '@kilocode/session-ingest-contracts';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';

/** A handle with its JWT expiry, as the claim step needs it. */
export type ExpiringHandle = { handle: string; exp: number };

export type CanonicalHandleChoice =
  | { action: 'adopt-candidate'; handle: string }
  | { action: 'keep-canonical'; handle: string }
  | { action: 'fail' };

/**
 * Which handle a preparing member should be served, before the accepted set is
 * touched. A canonical with at least the proactive threshold left is kept; a
 * candidate replaces a near-expiry or ended canonical, and also replaces any
 * canonical this requestor cannot be served (a later expiry is not required once
 * the canonical is unusable); while a usable canonical is still valid it is kept
 * even if the mint cannot extend it.
 */
export function decideCanonicalHandle(input: {
  canonical: ExpiringHandle | null;
  canonicalUsable: boolean;
  candidate: ExpiringHandle | null;
  now: number;
  thresholdMs: number;
}): CanonicalHandleChoice {
  const { canonical, canonicalUsable, candidate, now, thresholdMs } = input;
  if (canonical !== null && canonicalUsable && canonical.exp - now >= thresholdMs) {
    return { action: 'keep-canonical', handle: canonical.handle };
  }
  if (
    candidate !== null &&
    (canonical === null || !canonicalUsable || candidate.exp > canonical.exp)
  ) {
    return { action: 'adopt-candidate', handle: candidate.handle };
  }
  if (canonical !== null && canonicalUsable && canonical.exp > now) {
    return { action: 'keep-canonical', handle: canonical.handle };
  }
  return { action: 'fail' };
}

/** The facade encoder's member-root cap, shared so admission and view agree. */
export const MAX_SCOPE_MEMBERS = MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS;

/**
 * A joining session was refused because its worktree scope is at the member
 * limit. Typed so admission can classify it as a specific diagnostic stage
 * without changing the closed failure-reason/subtype contracts.
 */
export class ScopeMemberLimitError extends Error {
  constructor() {
    super('Worktree credential scope member limit reached');
    this.name = 'ScopeMemberLimitError';
  }
}

/** The diagnostic stage `failRoute` records for a {@link ScopeMemberLimitError}. */
export const SCOPE_MEMBER_LIMIT_STAGE = 'scope_member_limit';

/**
 * A joining session was refused because another grant already serves its
 * checkout directory under a different credential class (modern runtime-proxy
 * vs legacy alias). One Kilo runtime serves one directory and holds one
 * credential source, so the classes may not mix. Typed so admission can
 * classify it as a specific diagnostic stage without changing the closed
 * failure-reason/subtype contracts.
 */
export class MixedCredentialClassError extends Error {
  constructor() {
    super('Directory credential class mismatch');
    this.name = 'MixedCredentialClassError';
  }
}

/** The diagnostic stage `failRoute` records for a {@link MixedCredentialClassError}. */
export const MIXED_CREDENTIAL_CLASS_STAGE = 'mixed_credential_class';

/**
 * A joining session was refused because its worktree scope is not adoptable: an
 * existing member still holds a stored proxy handle this Sandbox never accepted
 * for the current fence (a pre-deploy per-session handle). Admitting the joiner
 * would let two different handles share one directory process after the flip, so
 * it is refused with the same typed-error and diagnostic-stage channel. A scope
 * with no stored handles is adoptable, so its first member always adopts. Typed
 * so admission can classify it without changing the closed failure contracts.
 */
export class ScopeHandleConflictError extends Error {
  constructor() {
    super('Worktree scope handle conflict');
    this.name = 'ScopeHandleConflictError';
  }
}

/** The diagnostic stage `failRoute` records for a {@link ScopeHandleConflictError}. */
export const SCOPE_HANDLE_CONFLICT_STAGE = 'scope_handle_conflict';

/** The diagnostic stage for an admission error, or the caller's fallback. */
export function admissionFailureStage(error: unknown, fallback: string): string {
  if (error instanceof ScopeMemberLimitError) return SCOPE_MEMBER_LIMIT_STAGE;
  if (error instanceof MixedCredentialClassError) return MIXED_CREDENTIAL_CLASS_STAGE;
  if (error instanceof ScopeHandleConflictError) return SCOPE_HANDLE_CONFLICT_STAGE;
  return fallback;
}

export type ScopeGrantMember = { sessionId: string; kiloSessionId: string };

/** The worktree-scoped proxy scope identity a grant must satisfy to adopt. */
export function isWorkspaceProxyScope(grant: SessionCredentialGrant): boolean {
  return (
    grant.kilo.runtimeProxy !== undefined &&
    cloudAgentWorktreeIdSchema.safeParse(grant.scopeId).success
  );
}

/** Distinct member-root session ids across grants sharing one scope id. */
export function scopeMemberCount(
  grants: readonly SessionCredentialGrant[],
  scopeId: string
): number {
  const ids = new Set<string>();
  for (const grant of grants) {
    if (grant.scopeId !== scopeId) continue;
    for (const member of grant.members) ids.add(member.sessionId);
  }
  return ids.size;
}

/**
 * Clears a grant's runtime-proxy member projection on wrapper replacement,
 * preserving every other compatible field. Returns the same grant when there is
 * nothing to clear, so the caller can skip a write.
 */
export function clearRuntimeProxyMembers(grant: SessionCredentialGrant): SessionCredentialGrant {
  const proxy = grant.kilo.runtimeProxy;
  if (proxy === undefined || proxy.members.length === 0) return grant;
  return {
    ...grant,
    kilo: {
      ...grant.kilo,
      runtimeProxy: { ...proxy, members: [] },
    },
  };
}

/**
 * Whether a worktree proxy scope is adoptable: a plain worktree proxy scope with
 * no stored proxy members, or one that has at least one accepted handle under the
 * current fence. The marker is inclusive of an expired-but-stored entry, because
 * a scope whose canonical has just ended is still adopted and must be recoverable
 * rather than treated as a pre-deploy per-session scope. This is the single owner
 * of the adoptability question; membership (digest) checks additionally use
 * {@link listAcceptedHandlesForScopeIncludingExpired}.
 */
export function isAdoptableWorktreeScope(input: {
  grant: SessionCredentialGrant;
  acceptedMarker: boolean;
}): boolean {
  if (!isWorkspaceProxyScope(input.grant)) return false;
  const members = input.grant.kilo.runtimeProxy?.members ?? [];
  return members.length === 0 || input.acceptedMarker;
}

/**
 * Writes the final handle onto the requesting member's own row only, adding the
 * row when absent. Other members keep the handle they already serve. Returns the
 * same grant reference when the requestor row already holds the handle, so
 * callers can skip a policy refresh and write.
 */
export function withMemberHandle(
  grant: SessionCredentialGrant,
  handle: string,
  member: ScopeGrantMember
): SessionCredentialGrant {
  const proxy = grant.kilo.runtimeProxy;
  if (proxy === undefined) return grant;
  const index = proxy.members.findIndex(current => current.sessionId === member.sessionId);
  const existing = index >= 0 ? proxy.members[index] : undefined;
  if (existing !== undefined && existing.handle === handle) return grant;
  const members =
    index >= 0
      ? proxy.members.map((current, position) =>
          position === index ? { ...current, handle } : current
        )
      : [...proxy.members, { ...member, handle }];
  return {
    ...grant,
    kilo: {
      ...grant.kilo,
      runtimeProxy: { ...proxy, members },
    },
  };
}

/** One freshly minted canonical scope handle, read off its signed JWT. */
export type CanonicalHandleMint = { handle: string; exp: number; issuerSessionId: string };

/** Single-flight key for a scope's canonical mint, partitioned by live fence. */
export function canonicalMintKey(
  grantId: string,
  fence: { allocationId: string; providerInstanceId: string; wrapperInstanceId: string }
): string {
  return `${grantId}\u0000${fence.allocationId}\u0000${fence.providerInstanceId}\u0000${fence.wrapperInstanceId}`;
}

/**
 * Single-flight owner for a scope's canonical mint. Concurrent preparers of the
 * same scope and fence share one Session DO call; a failed mint clears its entry
 * so a later prepare mints fresh rather than reusing a resolved null.
 */
export class CanonicalHandleMinter<TPeer, TFence> {
  private readonly inFlight = new Map<string, Promise<CanonicalHandleMint | null>>();

  constructor(
    private readonly mint: (peer: TPeer, fence: TFence) => Promise<string | null>,
    private readonly claimsFor: (
      handle: string
    ) => Promise<{ exp: number; sessionId: string } | null>
  ) {}

  get size(): number {
    return this.inFlight.size;
  }

  /** Mints one handle through `peer` and reads its signed JWT facts. */
  async direct(peer: TPeer, fence: TFence): Promise<CanonicalHandleMint | null> {
    const handle = await this.mint(peer, fence);
    if (handle === null) return null;
    const claims = await this.claimsFor(handle);
    if (claims === null) return null;
    return { handle, exp: claims.exp * 1000, issuerSessionId: claims.sessionId };
  }

  /** Deduplicates concurrent preparers onto one mint for `key`. */
  async shared(key: string, peer: TPeer, fence: TFence): Promise<CanonicalHandleMint | null> {
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const mint = this.direct(peer, fence);
    this.inFlight.set(key, mint);
    try {
      return await mint;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
