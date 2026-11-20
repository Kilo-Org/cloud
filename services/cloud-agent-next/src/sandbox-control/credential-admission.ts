import type { AllocationState } from '../control-plane/sandbox/allocation.js';
import type { AgentSandboxProvider } from '../types.js';

export type CredentialAuthority = {
  userId: string;
  orgId?: string;
  sandboxId: string;
  provider: AgentSandboxProvider;
  outboundContainerId?: string;
  preparedAt: number;
  expiresAt: number;
  members: readonly { sessionId: string }[];
};

export type CredentialAdmissionContext<G extends CredentialAuthority> = {
  sandboxId: string;
  ownerId: string | null;
  provider: AgentSandboxProvider;
  containmentEnabled: boolean;
  allocation: Pick<AllocationState, 'kind' | 'allocationId' | 'providerRef'>;
  outboundContainerId: string | null;
  grants: readonly G[];
  liveSessionIds: readonly string[];
  organizationId?: string;
  identityBinding: string;
  available: boolean;
};

export type CredentialAdmissionDenial = {
  ok: false;
  status: 401 | 403 | 503;
  code: string;
  retryAfter?: number;
};
export type CredentialIdentityVerification =
  | { ok: true; isCurrent: () => boolean }
  | CredentialAdmissionDenial;
export type CredentialAdmissionDependencies<
  G extends CredentialAuthority,
  C extends CredentialAdmissionContext<G> = CredentialAdmissionContext<G>,
> = {
  serial: <T>(operation: () => Promise<T>) => Promise<T>;
  readContext: () => Promise<C>;
  authenticate: (context: C) => Promise<CredentialIdentityVerification>;
  grantAdmitted: (grant: G) => boolean;
  now?: () => number;
};

function live(context: CredentialAdmissionContext<CredentialAuthority>): boolean {
  return (
    context.available &&
    context.containmentEnabled &&
    context.ownerId !== null &&
    context.outboundContainerId !== null &&
    context.allocation.allocationId !== null &&
    context.allocation.providerRef !== null &&
    context.allocation.kind !== 'stopped' &&
    context.allocation.kind !== 'stopping'
  );
}

function sameAllocation(
  current: CredentialAdmissionContext<CredentialAuthority>,
  initial: CredentialAdmissionContext<CredentialAuthority>
): boolean {
  return (
    live(current) &&
    current.sandboxId === initial.sandboxId &&
    current.ownerId === initial.ownerId &&
    current.provider === initial.provider &&
    current.outboundContainerId === initial.outboundContainerId &&
    current.organizationId === initial.organizationId &&
    current.identityBinding === initial.identityBinding &&
    current.allocation.allocationId === initial.allocation.allocationId &&
    current.allocation.providerRef === initial.allocation.providerRef
  );
}

export async function withCredentialAdmission<
  G extends CredentialAuthority,
  C extends CredentialAdmissionContext<G>,
  T,
>(
  deps: CredentialAdmissionDependencies<G, C>,
  use: (context: C, currentGrants: () => Promise<G[] | null>) => Promise<T>
): Promise<T | CredentialAdmissionDenial> {
  const context = await deps.serial(deps.readContext);
  if (!live(context)) return { ok: false, status: 403, code: 'allocation_unavailable' };
  const identity = await deps.authenticate(context);
  if (!identity.ok) return identity;
  return deps.serial(() =>
    use(context, async () => {
      const current = await deps.readContext();
      if (!sameAllocation(current, context) || !identity.isCurrent()) return null;
      const now = (deps.now ?? Date.now)();
      return current.grants.filter(
        grant =>
          deps.grantAdmitted(grant) &&
          grant.userId === current.ownerId &&
          grant.sandboxId === current.sandboxId &&
          grant.provider === current.provider &&
          grant.outboundContainerId === current.outboundContainerId &&
          grant.preparedAt <= now &&
          grant.expiresAt > now &&
          grant.members.some(member => current.liveSessionIds.includes(member.sessionId)) &&
          (current.organizationId === undefined || grant.orgId === current.organizationId)
      );
    })
  );
}
