import { worktreeBranchOperationRequestSchema } from '@kilocode/worker-utils/cloud-agent-worktree-operations';
import { z } from 'zod';

export {
  worktreeBranchOperationRefusalReasonSchema,
  worktreeBranchOperationRequestSchema,
  worktreeBranchOperationResultSchema,
  worktreeBranchOperationSchema,
  type WorktreeBranchOperation,
  type WorktreeBranchOperationRefusalReason,
  type WorktreeBranchOperationRequest,
  type WorktreeBranchOperationResult,
} from '@kilocode/worker-utils/cloud-agent-worktree-operations';

/** Route identity a branch operation runs against, matching `worktree.summary`. */
export const worktreeGitSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    directory: z.string().min(1).max(1024),
  })
  .strict();

/**
 * Session DO -> Sandbox DO branch operation. The Session DO forwards exactly one
 * `worktree.git` frame to the wrapper and returns its `worktree.result`.
 */
export const controlPlaneWorktreeGitInputSchema = z
  .object({
    session: worktreeGitSessionSchema,
    payload: worktreeBranchOperationRequestSchema,
  })
  .strict();

/** Wrapper frame for a branch operation; the reply is the shared `worktree.result`. */
export const controlPlaneWorktreeGitFrameSchema = z
  .object({
    type: z.literal('worktree.git'),
    requestId: z.string().min(1).max(128),
    session: worktreeGitSessionSchema,
    payload: worktreeBranchOperationRequestSchema,
  })
  .strict();

export type WorktreeGitSession = z.infer<typeof worktreeGitSessionSchema>;
export type ControlPlaneWorktreeGitInput = z.infer<typeof controlPlaneWorktreeGitInputSchema>;
export type ControlPlaneWorktreeGitFrame = z.infer<typeof controlPlaneWorktreeGitFrameSchema>;
