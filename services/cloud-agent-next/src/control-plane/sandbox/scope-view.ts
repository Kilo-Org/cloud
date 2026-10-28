import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import type { ScopeHandleRoute } from './scope-handle-resolution.js';

/**
 * The authorization view the Session DO returns with a resolved adopted handle.
 * `memberRootKiloSessionIds` are the canonical grant's member roots whose route
 * currently exists and has not failed; `expectedOrganizationId` is explicit null
 * for a personal scope. The facade reads it to choose the membership-checked
 * public path or the child v2 path.
 */
export type ScopeGrantView = {
  scopeId: string;
  expectedOrganizationId: string | null;
  memberRootKiloSessionIds: string[];
};

/** A member still backed by a live (non-failed) route at the grant's directory. */
export function isActiveScopeMember(
  member: SessionCredentialGrant['members'][number],
  route: ScopeHandleRoute | undefined,
  grant: SessionCredentialGrant
): boolean {
  return (
    route !== undefined &&
    route.state !== 'failed' &&
    route.spec.kiloSessionId === member.kiloSessionId &&
    route.spec.directory === grant.directory
  );
}

export function buildScopeGrantView(
  grant: SessionCredentialGrant,
  routes: readonly ScopeHandleRoute[]
): ScopeGrantView {
  const memberRootKiloSessionIds: string[] = [];
  for (const member of grant.members) {
    const route = routes.find(candidate => candidate.sessionId === member.sessionId);
    if (isActiveScopeMember(member, route, grant))
      memberRootKiloSessionIds.push(member.kiloSessionId);
  }
  return {
    scopeId: grant.scopeId,
    expectedOrganizationId: grant.orgId ?? null,
    memberRootKiloSessionIds,
  };
}
