import type { Env } from '../types.js';
import type { WorktreeCleanupOwner } from './schemas.js';

export function getWorktreeCleanupStub(
  env: Pick<Env, 'WORKTREE_CLEANUP'>,
  owner: WorktreeCleanupOwner
) {
  return env.WORKTREE_CLEANUP.getByName(
    JSON.stringify([owner.userId, owner.kilocodeOrganizationId ?? null])
  );
}
