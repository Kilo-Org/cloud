import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';
import {
  deleteContextAllocation,
  deleteRepoAllocation,
  selectAllocationSettings,
  upsertContextAllocation,
  upsertRepoAllocation,
  type SandboxAllocationSettingRow,
} from './sandbox-allocation-settings-db';
import { canonicalRepoFullName } from './repo-binding-db';

export type RepositoryAllocationSetting = {
  repositoryFullName: string;
  repositoryPlatform: RepositoryPlatform;
  allocation: string;
};

export type SandboxAllocationSettings = {
  contextAllocation: string | null;
  repositories: RepositoryAllocationSetting[];
};

export type SandboxAllocationCandidates = {
  repositoryAllocation?: string;
  contextAllocation?: string;
};

function isRepositoryRow(row: SandboxAllocationSettingRow): row is SandboxAllocationSettingRow & {
  repositoryFullName: string;
  repositoryPlatform: RepositoryPlatform;
} {
  return row.repositoryFullName !== null && row.repositoryPlatform !== null;
}

export async function getSandboxAllocationSettings(
  db: ProfileDatabase,
  owner: ProfileOwner
): Promise<SandboxAllocationSettings> {
  const rows = await selectAllocationSettings(db, owner);
  const context = rows.find(row => row.repositoryFullName === null);
  return {
    contextAllocation: context?.allocation ?? null,
    repositories: rows.filter(isRepositoryRow).map(row => ({
      repositoryFullName: row.repositoryFullName,
      repositoryPlatform: row.repositoryPlatform,
      allocation: row.allocation,
    })),
  };
}

/**
 * Raw saved values in resolution order for a new allocation: the repository
 * override first, then the context default. Eligibility and repository
 * compatibility are decided by the caller.
 */
export async function getSandboxAllocationCandidates(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repository?: { platform: RepositoryPlatform; fullName: string }
): Promise<SandboxAllocationCandidates> {
  const rows = await selectAllocationSettings(db, owner);
  const context = rows.find(row => row.repositoryFullName === null);
  const repositoryRow = repository
    ? rows.find(
        row =>
          row.repositoryFullName === canonicalRepoFullName(repository.fullName) &&
          row.repositoryPlatform === repository.platform
      )
    : undefined;
  return {
    ...(repositoryRow ? { repositoryAllocation: repositoryRow.allocation } : {}),
    ...(context ? { contextAllocation: context.allocation } : {}),
  };
}

export async function setContextSandboxAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner,
  allocation: string
): Promise<void> {
  await upsertContextAllocation(db, owner, allocation);
}

export async function clearContextSandboxAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner
): Promise<void> {
  await deleteContextAllocation(db, owner);
}

export async function setRepoSandboxAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform,
  allocation: string
): Promise<void> {
  await upsertRepoAllocation(db, owner, canonicalRepoFullName(repoFullName), platform, allocation);
}

export async function clearRepoSandboxAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  await deleteRepoAllocation(db, owner, canonicalRepoFullName(repoFullName), platform);
}
