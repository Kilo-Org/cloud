import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';
import { withProfileTransaction } from './database';
import { bindProfileToRepo, removeRepoBinding } from './repo-binding-service';
import {
  clearRepoSandboxAllocation,
  setRepoSandboxAllocation,
} from './sandbox-allocation-settings-service';

export type RepositorySettingsInput = {
  profileId?: string | null;
  allocation?: string | null;
};

/**
 * Applies a repository's profile binding and allocation override in one
 * transaction. An empty field clears that half independently; both empty
 * removes the binding and override idempotently.
 */
export async function setRepositorySettings(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform,
  input: RepositorySettingsInput
): Promise<void> {
  await withProfileTransaction(db, async tx => {
    if (input.allocation) {
      await setRepoSandboxAllocation(tx, owner, repoFullName, platform, input.allocation);
    } else {
      await clearRepoSandboxAllocation(tx, owner, repoFullName, platform);
    }
    if (input.profileId) {
      await bindProfileToRepo(tx, owner, repoFullName, platform, input.profileId);
    } else {
      await removeRepoBinding(tx, owner, repoFullName, platform);
    }
  });
}

export async function removeRepositorySettings(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  // Same row order as setRepositorySettings (allocation, then binding), so two
  // concurrent writes for one repository cannot lock the rows in opposite order.
  await withProfileTransaction(db, async tx => {
    await clearRepoSandboxAllocation(tx, owner, repoFullName, platform);
    await removeRepoBinding(tx, owner, repoFullName, platform);
  });
}
