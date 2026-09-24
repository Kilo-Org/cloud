import { E2BProviderError } from '../byoc/e2b-errors.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import type { SandboxProviderBinding } from '../sandbox-provider-binding.js';
import { sessionAttachPayloadSchema } from '../shared/sandbox-control-protocol.js';
import {
  credentialGrantMatchesProvider,
  type SessionCredentialGrant,
} from './session-credentials.js';
import type { SessionRoute } from './session-routes.js';

/**
 * Fail-closed admission for an E2B session request. Rejects unless the canonical
 * allocation is `allocated`, its submitted block carries a reference, the
 * resolved containment is worktree-scoped and bound to that reference, and a
 * live grant matches the binding, sandbox id, owner, directory and member. The
 * attach payload, when present, must match the grant exactly.
 */
export function authorizeE2BSessionRequest(input: {
  binding: SandboxProviderBinding;
  allocation: AllocationRecord;
  route: SessionRoute;
  grants: SessionCredentialGrant[];
  attachPayload?: unknown;
  now: number;
}): void {
  const { binding } = input;
  if (binding.kind !== 'e2b') return;
  const state = input.allocation.state;
  if (state.kind !== 'allocated') throw new E2BProviderError('byoc_e2b_policy_mismatch');
  const { target } = state;
  const e2b = target.e2b;
  const containment = target.resolvedContainment;
  const providerRef = target.providerRef;
  const grant = input.grants.find(
    value =>
      credentialGrantMatchesProvider(value, binding) &&
      value.orgId === binding.organizationId &&
      value.sandboxId === e2b?.sandboxId &&
      value.userId === input.route.ownerId &&
      value.directory === input.route.directory &&
      value.preparedAt <= input.now &&
      value.expiresAt > input.now &&
      value.members.some(
        member =>
          member.sessionId === input.route.sessionId &&
          member.kiloSessionId === input.route.kiloSessionId
      )
  );
  if (
    e2b?.submissionState !== 'submitted' ||
    providerRef === null ||
    !grant ||
    containment?.kilocode !== false ||
    containment.github !== false ||
    containment.worktreeScoped !== true ||
    containment.providerRef !== providerRef
  ) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
  if (input.attachPayload === undefined) return;
  const parsed = sessionAttachPayloadSchema.safeParse(input.attachPayload);
  if (
    !parsed.success ||
    parsed.data.kilo?.containmentEnabled !== false ||
    parsed.data.kilo.organizationId !== grant.orgId ||
    parsed.data.kilo.scopeId !== grant.scopeId ||
    parsed.data.kilo.token !== grant.kilo.token ||
    JSON.stringify(parsed.data.kilo.targets) !== JSON.stringify(grant.kilo.targets)
  ) {
    throw new E2BProviderError('byoc_e2b_policy_mismatch');
  }
}
