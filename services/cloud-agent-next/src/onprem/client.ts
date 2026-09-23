import type {
  AuthorizeOnPremAllocationInput,
  LaunchOnPremAllocationInput,
  OnPremInstallation,
  ReserveOnPremAllocationInput,
} from './installation.js';
import {
  onPremOrganizationIdSchema,
  type OnPremProviderBinding,
} from '../shared/onprem-protocol.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';

type OnPremEnv = Pick<Env, 'ONPREM_INSTALLATION'>;

const errorStatuses = {
  onprem_invalid_request: 400,
  onprem_unauthorized: 401,
  onprem_organization_mismatch: 403,
  onprem_installation_not_found: 404,
  onprem_allocation_not_found: 404,
  onprem_already_enrolled: 409,
  onprem_profile_mismatch: 409,
  onprem_cleanup_pending: 409,
  onprem_selection_conflict: 409,
  onprem_allocation_conflict: 409,
  onprem_installation_revoked: 409,
  onprem_allocation_stopped: 409,
  onprem_enrollment_expired: 410,
  onprem_allocation_expired: 410,
  onprem_capacity_exceeded: 429,
  onprem_binding_unavailable: 503,
  onprem_installation_not_ready: 503,
  onprem_state_invalid: 503,
  onprem_unavailable: 503,
} as const;

export function projectOnPremError(error: unknown) {
  const code =
    error instanceof Error && Object.hasOwn(errorStatuses, error.message)
      ? (error.message as keyof typeof errorStatuses)
      : 'onprem_unavailable';
  return { code, status: errorStatuses[code] };
}

function sanitizedRpcError(error: unknown): Error {
  return Object.assign(new Error(projectOnPremError(error).code), {
    retryable: error instanceof Error && 'retryable' in error && error.retryable === true,
  });
}

export function getOnPremInstallationStub(
  env: OnPremEnv,
  organizationId: string
): DurableObjectStub<OnPremInstallation> {
  const parsed = onPremOrganizationIdSchema.safeParse(organizationId);
  if (!parsed.success) throw new Error('onprem_organization_mismatch');
  if (!env.ONPREM_INSTALLATION) throw new Error('onprem_binding_unavailable');
  try {
    return env.ONPREM_INSTALLATION.getByName(parsed.data);
  } catch (error) {
    throw sanitizedRpcError(error);
  }
}

export function withOnPremInstallation<T>(
  env: OnPremEnv,
  organizationId: string,
  operation: (stub: DurableObjectStub<OnPremInstallation>) => Promise<T>,
  operationName: string
): Promise<T> {
  return withDORetry(
    () => getOnPremInstallationStub(env, organizationId),
    async stub => {
      try {
        return await operation(stub);
      } catch (error) {
        throw sanitizedRpcError(error);
      }
    },
    operationName
  );
}

export function getSelectedBinding(env: OnPremEnv, organizationId: string) {
  return withOnPremInstallation(
    env,
    organizationId,
    stub => stub.getSelectedBinding(onPremOrganizationIdSchema.parse(organizationId)),
    'getSelectedOnPremBinding'
  );
}

export function resolveProfile(env: OnPremEnv, binding: OnPremProviderBinding) {
  return withOnPremInstallation(
    env,
    binding.organizationId,
    stub =>
      stub.resolveProfile({
        ...binding,
        organizationId: onPremOrganizationIdSchema.parse(binding.organizationId),
      }),
    'resolveOnPremProfile'
  );
}

export function reserveAllocation(env: OnPremEnv, input: ReserveOnPremAllocationInput) {
  return withOnPremInstallation(
    env,
    input.binding.organizationId,
    stub =>
      stub.reserveAllocation({
        ...input,
        binding: {
          ...input.binding,
          organizationId: onPremOrganizationIdSchema.parse(input.binding.organizationId),
        },
      }),
    'reserveOnPremAllocation'
  );
}

export function launchAllocation(
  env: OnPremEnv,
  organizationId: string,
  input: LaunchOnPremAllocationInput
) {
  return withOnPremInstallation(
    env,
    organizationId,
    stub => stub.launchAllocation(input),
    'launchOnPremAllocation'
  );
}

export function getAllocation(env: OnPremEnv, organizationId: string, providerRef: string) {
  return withOnPremInstallation(
    env,
    organizationId,
    stub => stub.getAllocation(providerRef),
    'getOnPremAllocation'
  );
}

export function observeAllocation(env: OnPremEnv, organizationId: string, providerRef: string) {
  return withOnPremInstallation(
    env,
    organizationId,
    stub => stub.observeAllocation(providerRef),
    'observeOnPremAllocation'
  );
}

export function stopAllocation(
  env: OnPremEnv,
  organizationId: string,
  providerRef: string,
  reason?: string
) {
  return withOnPremInstallation(
    env,
    organizationId,
    stub => stub.stopAllocation(providerRef, reason),
    'stopOnPremAllocation'
  );
}

export function authorizeAllocation(
  env: OnPremEnv,
  organizationId: string,
  input: AuthorizeOnPremAllocationInput
) {
  return withOnPremInstallation(
    env,
    organizationId,
    stub => stub.authorizeAllocation(input),
    'authorizeOnPremAllocation'
  );
}
