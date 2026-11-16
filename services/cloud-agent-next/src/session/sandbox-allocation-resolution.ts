import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import { getSandboxAllocationCandidates, type ProfileOwner } from '@kilocode/cloud-agent-profile';
import { repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import {
  allocationSupportsMultiRepository,
  getSandboxAllocationProvider,
  isSelectableSandboxAllocation,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import { providerSupports } from '@kilocode/worker-utils/sandbox-provider-capabilities';
import { isMultiRepositoryEnvironment } from '../environment-build/reference.js';
import {
  getSandboxSelectionCapabilities,
  isSandboxAllocationAvailable,
  resolveVercelSelectionReadiness,
  type SandboxAllocationCapability,
  type SessionRepositoryType,
  type VercelSelectionReadiness,
} from '../sandbox-selection.js';
import { requiredProviderCapability } from '../session-identity.js';
import type { Env } from '../types.js';
import type {
  SessionCreateRequest,
  SessionRepositoryRequest,
  SessionRuntimeIntent,
} from './session-requests.js';

export type RepositoryAllocationTarget = {
  platform: 'github' | 'gitlab';
  fullName: string;
};

type SelectionOwner = { userId: string; orgId?: string };
type EnvironmentRequest = Pick<SessionCreateRequest, 'environment'>['environment'];

export function repositoryAllocationTarget(
  repository: SessionRepositoryRequest
): RepositoryAllocationTarget | undefined {
  if (repository.type === 'github') return { platform: 'github', fullName: repository.repo };
  if (repository.type === 'gitlab') {
    const fullName = repoFullNameFromGitUrl(repository.url, repository.url);
    return fullName ? { platform: 'gitlab', fullName } : undefined;
  }
  return undefined;
}

function profileOwner(owner: SelectionOwner): ProfileOwner {
  return owner.orgId
    ? { type: 'organization', id: owner.orgId }
    : { type: 'user', id: owner.userId };
}

/**
 * Whether a create needs a sandbox that enforces an egress policy: an allowlist
 * or an egress audit. The start check and the saved-allocation resolution read
 * this one rule.
 */
export function requestNeedsEgressPolicy(runtime: SessionRuntimeIntent | undefined): boolean {
  return runtime?.egressMode === 'allowlist' || runtime?.egressAudit === true;
}

function selectableAllocations(candidates: (string | undefined)[]) {
  return candidates
    .filter((candidate): candidate is string => candidate !== undefined)
    .map(candidate => candidate as SandboxAllocation)
    .filter(isSelectableSandboxAllocation);
}

function enforcesRequestedEgress(
  allocation: SandboxAllocation,
  runtime: SessionRuntimeIntent | undefined
): boolean {
  return (
    !requestNeedsEgressPolicy(runtime) ||
    providerSupports(getSandboxAllocationProvider(allocation), 'egressPolicy')
  );
}

/**
 * Resolves the allocation that an owner's saved settings give a repository: the
 * eligible repository environment allocation first, then the eligible
 * repository override, then the eligible context default. Stale or
 * incompatible saved keys are skipped; the unavailable saved key is never
 * disabled or deleted. Every selectable allocation can hold a V2 environment,
 * so the result does not depend on the environment. When `runtime` needs an
 * egress policy, an owner default whose provider cannot enforce one is skipped.
 * The environment allocation is never skipped for that reason: the start fails
 * it with the reason. The new-session picker does not know the egress policy,
 * so it can show a default that a restricted session skips.
 */
export async function resolveSavedSandboxAllocation(args: {
  db: WorkerDb;
  env: Env;
  owner: SelectionOwner;
  repositoryType: SessionRepositoryType;
  target?: RepositoryAllocationTarget;
  capability?: SandboxAllocationCapability;
  environmentAllocation?: string;
  runtime?: SessionRuntimeIntent;
  readiness?: VercelSelectionReadiness;
}): Promise<SandboxAllocation | undefined> {
  const { db, env, owner, repositoryType, target, capability, environmentAllocation } = args;
  const selectionOptions = {
    repositoryType,
    ...(capability ? { capability } : {}),
    ...(args.readiness?.vercelUnavailableReason
      ? { vercelUnavailableReason: args.readiness.vercelUnavailableReason }
      : {}),
  };
  const candidates = await getSandboxAllocationCandidates(db, profileOwner(owner), target);
  const ownerDefaults = selectableAllocations([
    candidates.repositoryAllocation,
    candidates.contextAllocation,
  ]).filter(allocation => enforcesRequestedEgress(allocation, args.runtime));
  const allocations = [...selectableAllocations([environmentAllocation]), ...ownerDefaults];
  if (allocations.length === 0) return undefined;

  let capabilities = await getSandboxSelectionCapabilities(env, owner, selectionOptions);
  if (!capabilities.enabled) return undefined;

  let readiness = args.readiness;
  for (const allocation of allocations) {
    if (getSandboxAllocationProvider(allocation) === 'vercel' && readiness === undefined) {
      readiness = await resolveVercelSelectionReadiness(env, owner, capability);
      capabilities = await getSandboxSelectionCapabilities(env, owner, {
        ...selectionOptions,
        ...(readiness.vercelUnavailableReason
          ? { vercelUnavailableReason: readiness.vercelUnavailableReason }
          : {}),
      });
    }
    // The same check as the picker, so a saved choice that the picker offered is
    // never skipped here.
    if (isSandboxAllocationAvailable(capabilities, allocation)) return allocation;
  }
  return undefined;
}

/** The allocation requested for a create: the client's choice, else the saved one. */
export function requestedSandboxAllocation(
  input: Pick<SessionCreateRequest, 'runtime' | 'savedSandboxAllocation'>
): SandboxAllocation | undefined {
  return input.runtime?.sandboxAllocation ?? input.savedSandboxAllocation ?? undefined;
}

/** Provider tool capability for a create, from the trusted origin signals only. */
export function allocationCapabilityFor(
  input: Pick<SessionCreateRequest, 'options'>,
  billingOrigin: string | undefined
): SandboxAllocationCapability | undefined {
  return requiredProviderCapability({
    createdOnPlatform: input.options?.createdOnPlatform,
    billingOrigin,
  });
}

/**
 * Resolves the saved allocation once. A client's choice wins and is validated by
 * the caller, so settings are read only when the client named none and an
 * earlier call has not read them already.
 */
export async function withSavedSandboxAllocation(
  input: SessionCreateRequest,
  args: { db: WorkerDb; env: Env; userId: string; billingOrigin?: string }
): Promise<SessionCreateRequest> {
  if (
    input.runtime?.sandboxAllocation !== undefined ||
    input.savedSandboxAllocation !== undefined
  ) {
    return input;
  }
  const capability = allocationCapabilityFor(input, args.billingOrigin);
  // Code review keeps its trusted `crv-` sandbox, so saved settings never apply.
  if (capability === 'review') return { ...input, savedSandboxAllocation: null };
  const target = repositoryAllocationTarget(input.repository);
  const saved = await resolveSavedSandboxAllocation({
    db: args.db,
    env: args.env,
    owner: { userId: args.userId, orgId: input.options?.kilocodeOrganizationId },
    repositoryType: input.repository.type,
    ...(target ? { target } : {}),
    ...(capability ? { capability } : {}),
    ...(input.environmentSandboxAllocation
      ? { environmentAllocation: input.environmentSandboxAllocation }
      : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
  });
  return { ...input, savedSandboxAllocation: saved ?? null };
}

/**
 * A V2 environment keeps every repository in one workspace and gives each
 * repository its own contained capability, so it needs a sandbox that one
 * session owns. Every new session already has a contained credential grant,
 * because containment is mandatory, so this check covers the sandbox alone. A
 * session on the shared sandbox fails before it registers, with the reason.
 * `allocation` is the one the session will use, and `undefined` is the default
 * isolated sandbox.
 */
export function assertEnvironmentSupportsSandbox(input: {
  environment: EnvironmentRequest;
  allocation: SandboxAllocation | undefined;
}): void {
  if (!isMultiRepositoryEnvironment(input.environment)) return;
  const { allocation } = input;
  if (allocation !== undefined && !allocationSupportsMultiRepository(allocation)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A multi-repository environment cannot run on the shared sandbox',
    });
  }
}
