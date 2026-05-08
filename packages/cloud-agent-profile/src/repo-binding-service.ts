import type { WorkerDb } from '@kilocode/db';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner } from './types';
import { verifyProfileOwnership } from './profile-utils';
import {
  upsertBinding,
  findBinding,
  deleteBinding,
  selectBindingsWithProfiles,
} from './repo-binding-db';

type RepoBinding = {
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
};

/**
 * Bind an environment profile to a repository.
 * Atomic upsert — safe against concurrent calls for the same owner+repo+platform.
 */
export async function bindProfileToRepo(
  db: WorkerDb,
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab',
  profileId: string
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await upsertBinding(db, owner, repoFullName.toLowerCase(), platform, profileId);
}

/**
 * Remove the profile binding for a repository.
 */
export async function unbindRepo(
  db: WorkerDb,
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
): Promise<void> {
  const repoLower = repoFullName.toLowerCase();
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
 * Look up which profile is bound to a repo for the given owner.
 * Returns the profile_id if found, null otherwise.
 */
export async function getBindingForRepo(
  db: WorkerDb,
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
): Promise<string | null> {
  const repoLower = repoFullName.toLowerCase();
  const binding = await findBinding(db, owner, repoLower, platform);
  return binding?.profileId ?? null;
}

/**
 * List all repo-profile bindings for the given owner.
 */
export async function listBindings(db: WorkerDb, owner: ProfileOwner): Promise<RepoBinding[]> {
  return selectBindingsWithProfiles(db, owner);
}
