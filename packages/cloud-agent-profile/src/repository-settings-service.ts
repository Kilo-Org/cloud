import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cloud_agent_environments } from '@kilocode/db/schema';
import type { ProfileDatabase, ProfileOwner } from './types';
import { withProfileTransaction } from './database';
import {
  buildEnvironmentOwnershipCondition,
  environmentContainsRepository,
  selectActiveEnvironments,
} from './environment-lookup';
import type { EnvironmentTransaction } from './environment-service';
import {
  deleteRepositoryEnvironmentDefault,
  getRepositoryEnvironmentDefault,
  upsertRepositoryEnvironmentDefault,
  type RepositoryEnvironmentDefaultSetting,
  type RepositoryEnvironmentIdentity,
  type StoredRepositoryEnvironmentDefault,
} from './repository-environment-defaults-db';
import { bindProfileToRepo, removeRepoBinding } from './repo-binding-service';
import {
  clearRepoSandboxAllocation,
  setRepoSandboxAllocation,
} from './sandbox-allocation-settings-service';

export type RepositorySettingsRepository =
  | { platform: 'github'; repoFullName: string }
  | { platform: 'gitlab'; repoFullName: string; cloneUrl?: string };

export type RepositorySettingsInput = {
  profileId?: string | null;
  allocation?: string | null;
  /**
   * The repository's environment default. `undefined` preserves the stored
   * setting.
   */
  environment?: RepositoryEnvironmentDefaultSetting;
};

function environmentIdentity(
  repository: RepositorySettingsRepository
): RepositoryEnvironmentIdentity | undefined {
  switch (repository.platform) {
    case 'github':
      return { platform: 'github', repoFullName: repository.repoFullName };
    case 'gitlab':
      return repository.cloneUrl === undefined
        ? undefined
        : {
            platform: 'gitlab',
            repoFullName: repository.repoFullName,
            cloneUrl: repository.cloneUrl,
          };
  }
}

function requireEnvironmentIdentity(
  repository: RepositorySettingsRepository
): RepositoryEnvironmentIdentity {
  const identity = environmentIdentity(repository);
  if (!identity) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A GitLab clone URL is required to save or remove a repository environment default',
    });
  }
  return identity;
}

/**
 * A newly chosen named environment must belong to the same owner and contain
 * the repository identity. The `none` mode needs no environment, and an
 * unchanged stored default is not revalidated even when the client resends its
 * id, so a stale environment cannot block an unrelated profile or allocation
 * edit.
 */
async function assertDefaultEnvironmentContainsRepository(
  tx: EnvironmentTransaction,
  owner: ProfileOwner,
  environmentId: string,
  repository: RepositoryEnvironmentIdentity
): Promise<void> {
  const owned = and(
    eq(cloud_agent_environments.id, environmentId),
    buildEnvironmentOwnershipCondition(owner)
  );
  const [environment] = await selectActiveEnvironments(tx, owned);
  if (!environment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }

  const [containing] = await selectActiveEnvironments(
    tx,
    and(owned, environmentContainsRepository(repository))
  );
  if (!containing) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The selected environment does not contain this repository',
    });
  }
}

function isUnchangedStoredSetting(
  current: RepositoryEnvironmentDefaultSetting,
  next: StoredRepositoryEnvironmentDefault
): boolean {
  return next.mode === 'none'
    ? current.mode === 'none'
    : current.mode === 'environment' && current.environmentId === next.environmentId;
}

/**
 * Applies a repository's environment default, profile binding and allocation
 * override in one transaction. An empty field clears that half independently;
 * `automatic` removes the stored environment setting, and omitting it preserves
 * the stored setting. Clearing everything removes all three idempotently.
 */
export async function setRepositorySettings(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repository: RepositorySettingsRepository,
  input: RepositorySettingsInput
): Promise<void> {
  await withProfileTransaction(db, async tx => {
    const environment = input.environment;
    if (environment !== undefined) {
      const identity = requireEnvironmentIdentity(repository);
      if (environment.mode === 'automatic') {
        await deleteRepositoryEnvironmentDefault(tx, owner, identity);
      } else {
        const current = await getRepositoryEnvironmentDefault(tx, owner, identity);
        if (!isUnchangedStoredSetting(current, environment)) {
          if (environment.mode === 'environment') {
            await assertDefaultEnvironmentContainsRepository(
              tx,
              owner,
              environment.environmentId,
              identity
            );
          }
          await upsertRepositoryEnvironmentDefault(tx, owner, identity, environment);
        }
      }
    }
    if (input.allocation) {
      await setRepoSandboxAllocation(
        tx,
        owner,
        repository.repoFullName,
        repository.platform,
        input.allocation
      );
    } else {
      await clearRepoSandboxAllocation(tx, owner, repository.repoFullName, repository.platform);
    }
    if (input.profileId) {
      await bindProfileToRepo(
        tx,
        owner,
        repository.repoFullName,
        repository.platform,
        input.profileId
      );
    } else {
      await removeRepoBinding(tx, owner, repository.repoFullName, repository.platform);
    }
  });
}

export async function removeRepositorySettings(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repository: RepositorySettingsRepository
): Promise<void> {
  const identity = requireEnvironmentIdentity(repository);
  // Same row order as setRepositorySettings (default, allocation, then binding),
  // so two concurrent writes for one repository cannot lock the rows in
  // opposite order.
  await withProfileTransaction(db, async tx => {
    await deleteRepositoryEnvironmentDefault(tx, owner, identity);
    await clearRepoSandboxAllocation(tx, owner, repository.repoFullName, repository.platform);
    await removeRepoBinding(tx, owner, repository.repoFullName, repository.platform);
  });
}
