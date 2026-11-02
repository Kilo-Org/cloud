import { z } from 'zod';

/**
 * The two branch rewrites a Cloud Agent worktree may run itself (plan Phase 3).
 * Both operate only on the branch checked out in the worktree's own directory.
 */
export const worktreeBranchOperationSchema = z.enum(['sync', 'restack']);

const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const branchSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(branch => !branch.startsWith('-') && !/[\0\r\n]/.test(branch), 'Invalid branch name');
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    path =>
      !path.includes('\0') &&
      path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
    'Expected a repository-relative path'
  );

export const worktreeBranchOperationRequestSchema = z
  .object({
    operation: worktreeBranchOperationSchema,
    /** The base branch to restack onto, or the base used to report `baseSha` after Sync. */
    baseBranch: branchSchema.optional(),
    /** The fork point to replay from, normally `cloud_agent_worktrees.base_sha`. */
    upstreamSha: commitSchema.optional(),
  })
  .strict();

export const worktreeBranchOperationRefusalReasonSchema = z.enum([
  'turn_running',
  'dirty_worktree',
  'branch_owned_by_sibling',
  'remote_branch_missing',
  'branch_mismatch',
  'missing_upstream_sha',
  'rebase_in_progress',
  'lease_rejected',
  'remote_branch_not_changed',
]);

const branchOperationFields = {
  operation: worktreeBranchOperationSchema,
  baseBranch: branchSchema.nullable(),
  baseSha: commitSchema.nullable(),
  previousRemoteSha: commitSchema.nullable(),
  remoteSha: commitSchema.nullable(),
  headSha: commitSchema,
};

const changedWorktreeBranchOperationSchema = z
  .object({
    status: z.literal('changed'),
    branch: branchSchema,
    ...branchOperationFields,
  })
  .strict();

const unchangedWorktreeBranchOperationSchema = z
  .object({
    status: z.literal('unchanged'),
    branch: branchSchema,
    ...branchOperationFields,
  })
  .strict();

const conflictWorktreeBranchOperationSchema = z
  .object({
    status: z.literal('conflict'),
    branch: branchSchema,
    ...branchOperationFields,
    files: z.array(repositoryPathSchema).max(1000),
    /** The exact command that was aborted, for the follow-up agent turn. */
    command: z.string().min(1).max(4096),
    instruction: z.string().min(1).max(8192),
  })
  .strict();

const refusedWorktreeBranchOperationSchema = z
  .object({
    status: z.literal('refused'),
    branch: branchSchema.nullable(),
    ...branchOperationFields,
    // A refusal decided before any checkout (for example a sibling owns the
    // branch) has no HEAD to report.
    headSha: commitSchema.nullable(),
    reason: worktreeBranchOperationRefusalReasonSchema,
    message: z.string().min(1).max(4096),
  })
  .strict();

export const worktreeBranchOperationResultSchema = z.discriminatedUnion('status', [
  changedWorktreeBranchOperationSchema,
  unchangedWorktreeBranchOperationSchema,
  conflictWorktreeBranchOperationSchema,
  refusedWorktreeBranchOperationSchema,
]);

export type WorktreeBranchOperation = z.infer<typeof worktreeBranchOperationSchema>;
export type WorktreeBranchOperationRequest = z.infer<typeof worktreeBranchOperationRequestSchema>;
export type WorktreeBranchOperationRefusalReason = z.infer<
  typeof worktreeBranchOperationRefusalReasonSchema
>;
export type WorktreeBranchOperationResult = z.infer<typeof worktreeBranchOperationResultSchema>;
