import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

/**
 * Sandbox DO -> Session DO: the shared snapshot of a worktree advanced. It is
 * control-plane only; `src/shared` is bundled into the wrapper image, which
 * cannot resolve workspace packages.
 */
export const worktreeChangesReadySchema = z
  .object({
    worktreeId: cloudAgentWorktreeIdSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type WorktreeChangesReady = z.infer<typeof worktreeChangesReadySchema>;
