import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';

/**
 * Pure decisions for the runtime-proxy canonical handle: setting it across every
 * member row, choosing the member a proactive handoff should mint through, and
 * telling whether a release leaves a shared handle in use. Kept free of DO
 * storage so the rules are unit-testable and the call sites stay thin.
 */

export type ScopeProxyMember = {
  sessionId: string;
  kiloSessionId: string;
  handle: string;
};

/** The handle a route's grant projects for `sessionId`, or null when absent. */
export function memberHandleForSession(
  grant: SessionCredentialGrant,
  sessionId: string
): string | null {
  return (
    grant.kilo.runtimeProxy?.members.find(member => member.sessionId === sessionId)?.handle ?? null
  );
}

/** The handle a released route holds, if its scope still shares that handle. */
export function sharedCanonicalHandleSurvivesRelease(
  grant: SessionCredentialGrant | null,
  sessionId: string
): boolean {
  const members = grant?.kilo.runtimeProxy?.members ?? [];
  const released = members.find(member => member.sessionId === sessionId);
  if (released === undefined) return false;
  return members.some(
    member => member.sessionId !== sessionId && member.handle === released.handle
  );
}

/** Every member row set to one canonical handle; unchanged grants are returned. */
export function setAllMemberHandles(
  grant: SessionCredentialGrant,
  handle: string
): SessionCredentialGrant {
  const proxy = grant.kilo.runtimeProxy;
  if (proxy === undefined || proxy.members.length === 0) return grant;
  let changed = false;
  const members = proxy.members.map(member => {
    if (member.handle === handle) return member;
    changed = true;
    return { ...member, handle };
  });
  if (!changed) return grant;
  return { ...grant, kilo: { ...grant.kilo, runtimeProxy: { ...proxy, members } } };
}

export type HandoffMemberState = ScopeProxyMember & {
  /** Live delegation expiry from the member's Session DO, null when unavailable. */
  delegationExpiresAt: number | null;
  /** The member has a route that has not failed. */
  active: boolean;
};

export type HandoffCandidate = {
  sessionId: string;
  kiloSessionId: string;
  delegationExpiresAt: number;
};

/**
 * The member a proactive handoff mints through: an active member whose *live*
 * delegation strictly outlives the canonical handle, furthest first. Members
 * whose delegation does not extend the canonical are never chosen, so a mint
 * cannot return an unchanged lease.
 */
export function selectHandoffCandidate(input: {
  canonicalExp: number;
  members: readonly HandoffMemberState[];
}): HandoffCandidate | null {
  let best: HandoffCandidate | null = null;
  for (const member of input.members) {
    if (!member.active) continue;
    const delegation = member.delegationExpiresAt;
    if (delegation === null || delegation <= input.canonicalExp) continue;
    if (best === null || delegation > best.delegationExpiresAt) {
      best = {
        sessionId: member.sessionId,
        kiloSessionId: member.kiloSessionId,
        delegationExpiresAt: delegation,
      };
    }
  }
  return best;
}
