import type { AllocationState } from '../control-plane/sandbox/allocation.js';
import {
  hasRuntimeCredentialProxy,
  type SessionCredentialGrant,
} from '../sandbox-control/session-credentials.js';
import { parseControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import {
  sandboxCredentialMatchesHash,
  hashSandboxCredential,
} from '../sandbox-control/credential.js';
import type {
  ControlPlaneScmForwardAdmission,
  ControlPlaneScmForwardAdmissionResult,
} from '../shared/control-plane-protocol.js';
import type { AgentSandboxProvider } from '../types.js';
import { grantScmEntries, selectScmEntry } from '../sandbox-control/session-credential-members.js';
import { classifyScmAuthorization, type ResolvedScmCapability } from './authorization.js';
import { hasManagedScmCapability, managedScmForwardingTargets } from './targets.js';

export type ScmAdmissionContext = {
  sandboxId: string;
  ownerId: string | null;
  provider: AgentSandboxProvider;
  containmentEnabled: boolean;
  allocation: Pick<AllocationState, 'kind' | 'allocationId' | 'providerRef'>;
  outboundContainerId: string | null;
  grants: readonly SessionCredentialGrant[];
  liveSessionIds: readonly string[];
  organizationId?: string;
  /** Adapter configuration used to verify this allocation's identity. */
  identityBinding: string;
  available: boolean;
};

type AdmissionDenial = Extract<ControlPlaneScmForwardAdmissionResult, { ok: false }>;
export type ScmIdentityVerification = { ok: true; isCurrent: () => boolean } | AdmissionDenial;

export type ScmAdmissionDependencies<C extends ScmAdmissionContext = ScmAdmissionContext> = {
  serial: <T>(operation: () => Promise<T>) => Promise<T>;
  readContext: () => Promise<C>;
  authenticate: (context: C) => Promise<ScmIdentityVerification>;
  resolve: (input: {
    grant: SessionCredentialGrant;
    credential: string;
    url: string;
    method: string;
    outboundContainerId: string;
  }) => Promise<{ grant: SessionCredentialGrant; credential: string } | null>;
  persist: (grant: SessionCredentialGrant) => void;
  now?: () => number;
};

function live(context: ScmAdmissionContext): boolean {
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

function activeGrants(context: ScmAdmissionContext, now: number) {
  return context.grants.filter(
    grant =>
      hasRuntimeCredentialProxy(grant) &&
      grant.userId === context.ownerId &&
      grant.sandboxId === context.sandboxId &&
      grant.provider === context.provider &&
      grant.outboundContainerId === context.outboundContainerId &&
      grant.preparedAt <= now &&
      grant.expiresAt > now &&
      grant.members.some(member => context.liveSessionIds.includes(member.sessionId)) &&
      (context.organizationId === undefined || grant.orgId === context.organizationId)
  );
}

async function grantForPresentedAlias(
  grants: readonly SessionCredentialGrant[],
  alias: string,
  provider: ResolvedScmCapability['provider']
): Promise<SessionCredentialGrant | undefined> {
  for (const candidate of grants) {
    if (!hasManagedScmCapability(candidate)) continue;
    for (const entry of grantScmEntries(candidate)) {
      if (entry.scm.purpose !== provider || !entry.scm.alias) continue;
      if (await sandboxCredentialMatchesHash(alias, await hashSandboxCredential(entry.scm.alias))) {
        return candidate;
      }
    }
  }
  return undefined;
}

function admittedTarget(url: URL, grants: readonly SessionCredentialGrant[], now: number) {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.hash &&
    managedScmForwardingTargets(grants, now).includes(url.host)
  );
}

function sameAllocation(current: ScmAdmissionContext, initial: ScmAdmissionContext): boolean {
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

/** SandboxControl owns serialization and storage. Adapters supply trusted identity evidence. */
export async function admitScmRequest<C extends ScmAdmissionContext>(
  input: Pick<ControlPlaneScmForwardAdmission, 'target' | 'authorization'>,
  deps: ScmAdmissionDependencies<C>
): Promise<ControlPlaneScmForwardAdmissionResult> {
  const deny = (code: string): AdmissionDenial => ({ ok: false, status: 403, code });
  const authorization = classifyScmAuthorization(input.authorization);
  if (authorization.type === 'denied') return deny('credential_denied');
  // Direct encrypted capabilities are supported only by the trusted native compatibility ingress.
  if (
    authorization.type === 'managed' &&
    !parseControlPlaneCredential(authorization.value.capability)
  )
    return deny('credential_denied');
  let url: URL;
  try {
    url = new URL(input.target.url);
  } catch {
    return deny('target_denied');
  }
  const now = deps.now ?? Date.now;
  const context = await deps.serial(deps.readContext);
  if (!live(context)) return deny('allocation_unavailable');
  // Provider account and key-service I/O must not hold the lifecycle queue.
  const identity = await deps.authenticate(context);
  if (!identity.ok) return identity;
  const isIdentityCurrent = identity.isCurrent;
  return deps.serial(async () => {
    async function currentGrants() {
      const current = await deps.readContext();
      if (!sameAllocation(current, context) || !isIdentityCurrent()) return null;
      const grants = activeGrants(current, now());
      return admittedTarget(url, grants, now()) ? grants : null;
    }
    const grants = await currentGrants();
    if (!grants) return deny('target_denied');
    if (authorization.type === 'unmanaged') return { ok: true, authority: { type: 'unmanaged' } };
    const alias = authorization.value.capability;
    const parsedAlias = parseControlPlaneCredential(alias);
    if (parsedAlias?.sandboxId !== context.sandboxId) return deny('credential_denied');
    const grant = await grantForPresentedAlias(grants, alias, authorization.value.provider);
    if (!grant?.scm?.alias || !grant.outboundContainerId) return deny('credential_denied');
    if (!admittedTarget(url, [grant], now())) return deny('target_denied');
    // Capture before renewal. A resolver must not mutate the authoritative input in place.
    const original = JSON.stringify(grant);
    const resolved = await deps.resolve({
      grant: structuredClone(grant),
      credential: alias,
      ...input.target,
      outboundContainerId: grant.outboundContainerId,
    });
    const selected = resolved ? selectScmEntry(resolved.grant, alias, url) : null;
    if (
      !resolved ||
      !selected ||
      !hasManagedScmCapability(resolved.grant) ||
      selected.scm.purpose !== authorization.value.provider ||
      selected.scm.alias !== alias ||
      !selected.scm.capability ||
      resolved.credential !== selected.scm.capability.credential ||
      resolved.grant.expiresAt <= now()
    )
      return deny('credential_denied');
    const latest = await currentGrants();
    if (!latest?.some(candidate => JSON.stringify(candidate) === original))
      return deny('credential_denied');
    deps.persist(resolved.grant);
    return {
      ok: true,
      authority: {
        type: 'managed',
        provider: selected.scm.purpose,
        capability: resolved.credential,
        outboundContainerId: grant.outboundContainerId,
      },
    };
  });
}
