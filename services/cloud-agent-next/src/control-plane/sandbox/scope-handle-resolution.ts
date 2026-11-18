import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import type { ScopeBackingToken } from './accepted-handles.js';
import { isActiveScopeMember } from './scope-view.js';

export type ScopeHandleMember = { sessionId: string; kiloSessionId: string };

export type ScopeHandleRoute = {
  sessionId: string;
  state: string;
  spec: { kiloSessionId: string; directory: string };
};

export type ScopeHandleCandidate = {
  member: ScopeHandleMember;
  ready: boolean;
};

/**
 * The current members of the canonical grant that can back a scope handle: each
 * has a route that is not `failed` and whose root kilo session and directory
 * match the grant. `ready` routes sort before `preparing`; within a group the
 * handle's own issuer sorts first for a stable attestation.
 */
export function selectScopeHandleCandidates(input: {
  grant: SessionCredentialGrant;
  routes: readonly ScopeHandleRoute[];
  issuerSessionId: string;
}): ScopeHandleCandidate[] {
  const { grant, routes, issuerSessionId } = input;
  const candidates: ScopeHandleCandidate[] = [];
  for (const member of grant.members) {
    const route = routes.find(candidate => candidate.sessionId === member.sessionId);
    if (!isActiveScopeMember(member, route, grant)) continue;
    candidates.push({ member, ready: route?.state === 'ready' });
  }
  candidates.sort((left, right) => {
    if (left.ready !== right.ready) return left.ready ? -1 : 1;
    const leftIssuer = left.member.sessionId === issuerSessionId ? 0 : 1;
    const rightIssuer = right.member.sessionId === issuerSessionId ? 0 : 1;
    return leftIssuer - rightIssuer;
  });
  return candidates;
}

/**
 * A backing token is valid for the scope only when it attests to the grant's
 * user and org and to the serving member's own session.
 */
export function scopeBackingMatchesGrant(
  backing: ScopeBackingToken,
  member: ScopeHandleMember,
  grant: SessionCredentialGrant
): boolean {
  return (
    backing.runtimeAuthorization.userId === grant.userId &&
    backing.runtimeAuthorization.resourceId === member.sessionId &&
    (backing.organizationId ?? null) === (grant.orgId ?? null)
  );
}

/** The scope identity the Sandbox DO asks a member to self-validate against. */
export function expectedScopeForCandidate(
  member: ScopeHandleMember,
  grant: SessionCredentialGrant
): { directory: string; kiloSessionId: string } {
  return { directory: grant.directory, kiloSessionId: member.kiloSessionId };
}

export type RenewedScopeCandidateDecision = 'deny' | 'skip' | 'serve';

/**
 * The decision for a candidate whose backing-token renewal has just completed.
 * The physical binding and the grant must still match (`deny` a stale or
 * vanished scope); the member must still belong to the grant and have an active
 * route (`skip`, so another candidate is tried). `serve` means the backing is
 * usable, subject to its own grant match. A member that left the grant or whose
 * route directory/root session drifted during the renewal is skipped, not denied,
 * so a survivor can still serve.
 */
export function decideRenewedScopeCandidate(input: {
  bindingMatches: boolean;
  grant: SessionCredentialGrant | null;
  member: ScopeHandleMember;
  route: ScopeHandleRoute | undefined;
}): RenewedScopeCandidateDecision {
  if (!input.bindingMatches || input.grant === null) return 'deny';
  const { grant, member, route } = input;
  if (
    !grant.members.some(
      candidate =>
        candidate.sessionId === member.sessionId && candidate.kiloSessionId === member.kiloSessionId
    )
  ) {
    return 'skip';
  }
  if (!isActiveScopeMember(member, route, grant)) return 'skip';
  return 'serve';
}
