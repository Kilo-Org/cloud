import 'server-only';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner } from './types';
import { verifyProfileOwnership } from './profile-utils';
import {
  findBinding,
  updateBindingProfile,
  insertBinding,
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
 * If the owner already has a binding for this repo+platform, updates it to the new profile.
 */
export async function bindProfileToRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab',
  profileId: string
): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  const repoLower = repoFullName.toLowerCase();
  const existing = await findBinding(owner, repoLower, platform);

  if (existing) {
    await updateBindingProfile(existing.bindingId, profileId);
  } else {
    await insertBinding(repoLower, platform, profileId);
  }
}

/**
 * Remove the profile binding for a repository.
 * Verifies ownership by joining through the profile before deleting.
 */
export async function unbindRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
): Promise<void> {
  const repoLower = repoFullName.toLowerCase();
  const binding = await findBinding(owner, repoLower, platform);

  if (!binding) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Repo binding not found',
    });
  }

  await deleteBinding(binding.bindingId);
}

/**
 * Look up which profile is bound to a repo for the given owner.
 * Returns the profile_id if found, null otherwise.
 */
export async function getBindingForRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
): Promise<string | null> {
  const repoLower = repoFullName.toLowerCase();
  const binding = await findBinding(owner, repoLower, platform);
  return binding?.profileId ?? null;
}

/**
 * List all repo-profile bindings for the given owner.
 */
export async function listBindings(owner: ProfileOwner): Promise<RepoBinding[]> {
  return selectBindingsWithProfiles(owner);
}
