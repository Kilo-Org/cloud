import type { AllocationState } from '../control-plane/sandbox/allocation.js';
import {
  hasRuntimeCredentialProxy,
  type SessionCredentialGrant,
} from '../sandbox-control/session-credentials.js';
import type {
  ControlPlaneScmForwardAdmission,
  ControlPlaneScmForwardAdmissionResult,
} from '../shared/control-plane-protocol.js';
import {
  activeScopedScmGrants,
  admitScopedScmRequest,
  type ScopedScmAdmissionContext,
  type ScopedScmAdmissionDependencies,
  type ScopedScmIdentityVerification,
} from './scoped-admission.js';

/** Session authority includes runtime readiness and live Session DO membership. */
export type ScmAdmissionContext = Omit<
  ScopedScmAdmissionContext<SessionCredentialGrant>,
  'allocation' | 'liveMemberIds'
> & {
  allocation: Pick<AllocationState, 'kind' | 'allocationId' | 'providerRef'>;
  liveSessionIds: readonly string[];
};
type SessionContext<C extends ScmAdmissionContext> = C &
  ScopedScmAdmissionContext<SessionCredentialGrant>;
export type ScmIdentityVerification = ScopedScmIdentityVerification;
export type ScmAdmissionDependencies<C extends ScmAdmissionContext = ScmAdmissionContext> = Omit<
  ScopedScmAdmissionDependencies<SessionCredentialGrant, SessionContext<C>>,
  'readContext' | 'authenticate' | 'memberIds'
> & {
  readContext: () => Promise<C>;
  authenticate: (context: C) => Promise<ScmIdentityVerification>;
};
export function sessionScmAdmissionContext<C extends ScmAdmissionContext>(
  context: C
): SessionContext<C> {
  return {
    ...context,
    allocation: {
      ...context.allocation,
      active: context.allocation.kind !== 'stopped' && context.allocation.kind !== 'stopping',
    },
    liveMemberIds: context.liveSessionIds,
    grants: context.grants.filter(hasRuntimeCredentialProxy),
  };
}
export const sessionScmMemberIds = (grant: SessionCredentialGrant) =>
  grant.members.map(member => member.sessionId);
export function activeScmGrants(context: ScmAdmissionContext, now: number) {
  return activeScopedScmGrants(sessionScmAdmissionContext(context), now, sessionScmMemberIds);
}
/** Provider adapters keep their identity contract. The SCM-only core owns repository rules. */
export function admitScmRequest<C extends ScmAdmissionContext>(
  input: Pick<ControlPlaneScmForwardAdmission, 'target' | 'authorization'>,
  deps: ScmAdmissionDependencies<C>
): Promise<ControlPlaneScmForwardAdmissionResult> {
  return admitScopedScmRequest<SessionCredentialGrant, SessionContext<C>>(input, {
    ...deps,
    memberIds: sessionScmMemberIds,
    readContext: async () => sessionScmAdmissionContext(await deps.readContext()),
  });
}
