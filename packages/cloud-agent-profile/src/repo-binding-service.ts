import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';
import { TRPCError } from '@trpc/server';
import { lockProfileOwnership } from './profile-utils';
import { withProfileTransaction } from './database';
import {
  upsertBinding,
  findBinding,
  deleteBinding,
  deleteBindingForRepo,
  selectBindingsWithProfiles,
  canonicalRepoFullName,
} from './repo-binding-db';

type RepoBinding = {
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
};

/**
 * Bind an environment profile to a repository. Locks the profile row before the
 * insert so a concurrent profile delete cannot cascade the new binding.
 */
export async function bindProfileToRepo(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform,
  profileId: string
): Promise<void> {
  await withProfileTransaction(db, async tx => {
    await lockProfileOwnership(tx, profileId, owner);
    await upsertBinding(tx, owner, canonicalRepoFullName(repoFullName), platform, profileId);
  });
}

export async function unbindRepo(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  const repoLower = canonicalRepoFullName(repoFullName);
  const binding = await findBinding(db, owner, repoLower, platform);

  if (!binding) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Repo binding not found',
    });
  }

  await deleteBinding(db, binding.bindingId);
}

/**
 * Idempotent remove for a repository binding. Absent bindings are a no-op.
 */
export async function removeRepoBinding(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  await deleteBindingForRepo(db, owner, canonicalRepoFullName(repoFullName), platform);
}

/**
 * Look up which profile is bound to a repo for the given owner.
 * Returns the profile_id if found, null otherwise.
 */
export async function getBindingForRepo(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<string | null> {
  const repoLower = canonicalRepoFullName(repoFullName);
  const binding = await findBinding(db, owner, repoLower, platform);
  return binding?.profileId ?? null;
}

export async function listBindings(
  db: ProfileDatabase,
  owner: ProfileOwner
): Promise<RepoBinding[]> {
  return selectBindingsWithProfiles(db, owner);
}
