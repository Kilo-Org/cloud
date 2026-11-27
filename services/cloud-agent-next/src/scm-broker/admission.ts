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
import {
  activeCredentialGrants,
  withCredentialAdmission,
  type CredentialAdmissionContext,
  type CredentialIdentityVerification,
} from '../sandbox-control/credential-admission.js';
import { grantScmEntries, selectScmEntry } from '../sandbox-control/session-credential-members.js';
import { classifyScmAuthorization, type ResolvedScmCapability } from './authorization.js';
import { hasManagedScmCapability, managedScmForwardingTargets } from './targets.js';

export type ScmAdmissionContext = CredentialAdmissionContext<SessionCredentialGrant>;

type AdmissionDenial = Extract<ControlPlaneScmForwardAdmissionResult, { ok: false }>;
export type ScmIdentityVerification = CredentialIdentityVerification;

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

/** The grants that admit a managed SCM request in this context. */
export function activeScmGrants(context: ScmAdmissionContext, now: number) {
  return activeCredentialGrants(context, now, hasRuntimeCredentialProxy);
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
  return withCredentialAdmission(
    { ...deps, grantAdmitted: hasRuntimeCredentialProxy },
    async (context, activeGrants) => {
      async function currentGrants() {
        const grants = await activeGrants();
        return grants && admittedTarget(url, grants, now()) ? grants : null;
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
    }
  );
}
