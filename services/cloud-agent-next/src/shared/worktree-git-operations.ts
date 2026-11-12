import type {
  WorktreeBranchOperation,
  WorktreeBranchOperationRefusalReason,
  WorktreeBranchOperationRequest,
  WorktreeBranchOperationResult,
} from '@kilocode/worker-utils/cloud-agent-worktree-operations';
import { z } from 'zod';

export type {
  WorktreeBranchOperation,
  WorktreeBranchOperationRefusalReason,
  WorktreeBranchOperationRequest,
  WorktreeBranchOperationResult,
};

// The standalone wrapper bundle cannot resolve worker-utils, so the branch
// operation contract is mirrored here (type-only import above).
// worktree-git-operations.test.ts keeps it in parity with the public contract.
const WORKTREE_BRANCH_OPERATIONS = [
  'sync',
  'restack',
] as const satisfies readonly WorktreeBranchOperation[];

const WORKTREE_BRANCH_OPERATION_REFUSAL_REASONS = [
  'turn_running',
  'dirty_worktree',
  'branch_owned_by_sibling',
  'remote_branch_missing',
  'branch_mismatch',
  'missing_upstream_sha',
  'rebase_in_progress',
  'lease_rejected',
  'remote_branch_not_changed',
] as const satisfies readonly WorktreeBranchOperationRefusalReason[];

export const worktreeBranchOperationSchema = z.enum(WORKTREE_BRANCH_OPERATIONS);
export const worktreeBranchOperationRefusalReasonSchema = z.enum(
  WORKTREE_BRANCH_OPERATION_REFUSAL_REASONS
);

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
    baseBranch: branchSchema.optional(),
    upstreamSha: commitSchema.optional(),
  })
  .strict() satisfies z.ZodType<WorktreeBranchOperationRequest>;

const branchOperationFields = {
  operation: worktreeBranchOperationSchema,
  baseBranch: branchSchema.nullable(),
  baseSha: commitSchema.nullable(),
  previousRemoteSha: commitSchema.nullable(),
  remoteSha: commitSchema.nullable(),
  headSha: commitSchema,
};

export const worktreeBranchOperationResultSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('changed'), branch: branchSchema, ...branchOperationFields })
    .strict(),
  z
    .object({ status: z.literal('unchanged'), branch: branchSchema, ...branchOperationFields })
    .strict(),
  z
    .object({
      status: z.literal('conflict'),
      branch: branchSchema,
      ...branchOperationFields,
      files: z.array(repositoryPathSchema).max(1000),
      command: z.string().min(1).max(4096),
      instruction: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      status: z.literal('refused'),
      branch: branchSchema.nullable(),
      ...branchOperationFields,
      headSha: commitSchema.nullable(),
      reason: worktreeBranchOperationRefusalReasonSchema,
      message: z.string().min(1).max(4096),
    })
    .strict(),
]) satisfies z.ZodType<WorktreeBranchOperationResult>;

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
