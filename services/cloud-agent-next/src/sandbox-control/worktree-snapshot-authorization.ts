import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { controlLogAllocationIdSchema } from '../shared/control-diagnostics.js';

export const WORKTREE_SNAPSHOT_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
export const WORKTREE_SNAPSHOT_TOMBSTONE_PREFIX = 'worktree_snapshot_tombstone/';

export const worktreeSnapshotAuthorizationInputSchema = z
  .object({
    allocationId: controlLogAllocationIdSchema,
    worktreeId: cloudAgentWorktreeIdSchema,
    credential: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const worktreeSnapshotTombstoneInputSchema = z
  .object({ worktreeId: cloudAgentWorktreeIdSchema })
  .strict();

export type WorktreeSnapshotAuthorizationInput = z.infer<
  typeof worktreeSnapshotAuthorizationInputSchema
>;

export function worktreeSnapshotObjectKey(worktreeId: string): string {
  return `v1/${worktreeId}.tar.gz`;
}

export function worktreeSnapshotTombstoneKey(worktreeId: string): string {
  return `${WORKTREE_SNAPSHOT_TOMBSTONE_PREFIX}${worktreeId}`;
}

export function worktreeSnapshotWritesEnabled(env: {
  WORKTREE_SNAPSHOT_WRITES_ENABLED?: string;
}): boolean {
  return env.WORKTREE_SNAPSHOT_WRITES_ENABLED === 'true';
}

export function worktreeSnapshotReadsEnabled(env: {
  WORKTREE_SNAPSHOT_WRITES_ENABLED?: string;
  WORKTREE_SNAPSHOT_READS_ENABLED?: string;
}): boolean {
  return worktreeSnapshotWritesEnabled(env) && env.WORKTREE_SNAPSHOT_READS_ENABLED === 'true';
}

export function decideWorktreeSnapshotAuthorization(input: {
  allocationId: string;
  currentAllocationId: string | null;
  allocationKind: string;
  routeScopeIds: readonly string[];
  worktreeId: string;
  tombstoned: boolean;
}): boolean {
  if (input.tombstoned) return false;
  if (input.currentAllocationId !== input.allocationId) return false;
  if (input.allocationKind === 'stopped' || input.allocationKind === 'stopping') return false;
  return input.routeScopeIds.some(scopeId => scopeId === input.worktreeId);
}

type SnapshotTombstoneStorage = {
  put(key: string, value: unknown): Promise<void>;
};

type SnapshotObjectBucket = {
  delete(key: string): Promise<void>;
};

/**
 * Writes the tombstone first, so a failed object delete still refuses later
 * reads and uploads. Returns false when object deletion fails. Orphan cleanup
 * requires a separately provisioned bucket lifecycle rule.
 */
export async function purgeWorktreeSnapshot(input: {
  worktreeId: string;
  storage: SnapshotTombstoneStorage;
  bucket?: SnapshotObjectBucket;
}): Promise<boolean> {
  await input.storage.put(worktreeSnapshotTombstoneKey(input.worktreeId), Date.now());
  if (!input.bucket) return true;
  try {
    await input.bucket.delete(worktreeSnapshotObjectKey(input.worktreeId));
    return true;
  } catch {
    return false;
  }
}
