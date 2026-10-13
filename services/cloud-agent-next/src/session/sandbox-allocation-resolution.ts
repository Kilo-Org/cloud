import type { WorkerDb } from '@kilocode/db/client';
import { getSandboxAllocationCandidates, type ProfileOwner } from '@kilocode/cloud-agent-profile';
import { repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import {
  isSelectableSandboxAllocation,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  getSandboxSelectionCapabilities,
  isSandboxAllocationAvailable,
  type SandboxAllocationCapability,
  type SessionRepositoryType,
} from '../sandbox-selection.js';
import { requiredProviderCapability } from '../session-plane.js';
import type { Env } from '../types.js';
import type { SessionCreateRequest, SessionRepositoryRequest } from './session-requests.js';

export type RepositoryAllocationTarget = {
  platform: 'github' | 'gitlab';
  fullName: string;
};

type SelectionOwner = { userId: string; orgId?: string };

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
 * Resolves the allocation that an owner's saved settings give a repository: the
 * eligible repository override first, then the eligible context default. Stale
 * or incompatible saved keys are skipped; the unavailable saved key is never
 * disabled or deleted. Session start and the new-session picker both read this,
 * so the picker shows what a session would actually use.
 */
export async function resolveSavedSandboxAllocation(args: {
  db: WorkerDb;
  env: Env;
  owner: SelectionOwner;
  repositoryType: SessionRepositoryType;
  target?: RepositoryAllocationTarget;
  capability?: SandboxAllocationCapability;
}): Promise<SandboxAllocation | undefined> {
  const { db, env, owner, repositoryType, target, capability } = args;
  const capabilities = getSandboxSelectionCapabilities(env, owner, {
    repositoryType,
    ...(capability ? { capability } : {}),
  });
  if (!capabilities.enabled) return undefined;

  const candidates = await getSandboxAllocationCandidates(db, profileOwner(owner), target);
  for (const candidate of [candidates.repositoryAllocation, candidates.contextAllocation]) {
    if (candidate === undefined) continue;
    const allocation = candidate as SandboxAllocation;
    if (!isSelectableSandboxAllocation(allocation)) continue;
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
  const target = repositoryAllocationTarget(input.repository);
  const capability = allocationCapabilityFor(input, args.billingOrigin);
  const saved = await resolveSavedSandboxAllocation({
    db: args.db,
    env: args.env,
    owner: { userId: args.userId, orgId: input.options?.kilocodeOrganizationId },
    repositoryType: input.repository.type,
    ...(target ? { target } : {}),
    ...(capability ? { capability } : {}),
  });
  return { ...input, savedSandboxAllocation: saved ?? null };
}
