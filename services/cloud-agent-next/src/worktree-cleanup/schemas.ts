import { cloudAgentWorktreeIdSchema, sessionIdSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

export const WorktreeCleanupScope = z
  .object({ kilocodeOrganizationId: z.uuid().optional() })
  .strict();

export const StartWorktreeCleanupInput = WorktreeCleanupScope.extend({
  worktreeIds: z.array(cloudAgentWorktreeIdSchema).min(1).max(1000),
});

export const WorktreeCleanupItem = z.object({
  worktreeId: cloudAgentWorktreeIdSchema,
  status: z.enum(['pending', 'deleting', 'deleted', 'failed']),
  deletedSessionIds: z.array(sessionIdSchema),
  error: z.string().nullable(),
});

export const WorktreeCleanup = z.object({
  id: z.string(),
  items: z.array(WorktreeCleanupItem),
  createdAt: z.iso.datetime(),
});

export type WorktreeCleanup = z.infer<typeof WorktreeCleanup>;

export const WorktreeCleanupOwner = WorktreeCleanupScope.extend({ userId: z.string().min(1) });
export type WorktreeCleanupOwner = z.infer<typeof WorktreeCleanupOwner>;

export const StoredWorktreeCleanupItem = WorktreeCleanupItem.extend({
  attempts: z.number().int().nonnegative(),
});

export const StoredWorktreeCleanupBatch = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  owner: WorktreeCleanupOwner,
});
