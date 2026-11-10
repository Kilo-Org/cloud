import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { WorktreeBranchOperationResult } from '../shared/worktree-git-operations.js';
import { withStackedWorkspaceInstruction } from './stacked-workspace-instruction.js';

/**
 * Flat, session-addressed input for the Worker Sync/Restack routes. The target
 * worktree, branch and sandbox are derived from the session; a caller can only
 * override the base branch and the recorded fork point.
 */
export type WorktreeBranchOperationInput = {
  baseBranch?: string;
  upstreamSha?: string;
};

/**
 * A branch operation that could not run at all (no worktree session, sandbox
 * not ready, invalid sandbox result). These are platform failures, not the
 * wrapper's `refused` status. The Worker maps the code to a bounded tRPC error
 * and never retries: a transport failure may mean the operation completed.
 */
export class WorktreeBranchOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'WorktreeBranchOperationError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** DO-returned union: a wrapper result, or a platform failure the Worker surfaces. */
export type WorktreeBranchOperationResponse =
  | { ok: true; result: WorktreeBranchOperationResult }
  | { ok: false; code: string; message: string; retryable: boolean };

export function nextRepositoryBase(input: {
  current: { baseBranch?: string; baseSha?: string };
  result: { baseBranch: string | null; baseSha: string | null };
}): { baseBranch?: string; baseSha?: string } {
  const baseBranch = input.result.baseBranch ?? input.current.baseBranch;
  const baseSha = input.result.baseSha ?? input.current.baseSha;
  return {
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(baseSha === undefined ? {} : { baseSha }),
  };
}

/** Flat input for the internal `adoptWorktreeBase` metadata mutation. */
export type AdoptWorktreeBaseRequest = {
  expectedWorktreeId: string;
  baseBranch: string;
  baseSha: string;
};

/** DO-returned union for `adoptWorktreeBase`; adoption is metadata only. */
export type AdoptWorktreeBaseResponse = { ok: true } | { ok: false; code: string; message: string };

/** A session may adopt a base only for the worktree it actually belongs to. */
export function matchesExpectedWorktree(
  metadata: SessionMetadata | null,
  expectedWorktreeId: string
): boolean {
  return metadata?.workspace?.worktreeId === expectedWorktreeId;
}

/**
 * Applies an effective base to grouped metadata and the stacked instruction.
 *
 * Shared only by operation persistence and sibling base adoption so a sibling
 * session's next Changes capture and system prompt cannot keep the old base.
 */
export function withRepositoryBase(
  metadata: SessionMetadata,
  base: { baseBranch?: string; baseSha?: string },
  fallbackBranch?: string
): SessionMetadata {
  if (metadata.repository === undefined) return metadata;
  const branch =
    metadata.workspace?.branchName ??
    fallbackBranch ??
    metadata.repository.upstreamBranch ??
    metadata.identity.sessionId;
  const effectiveBaseBranch = base.baseBranch ?? metadata.repository.baseBranch;
  const next: SessionMetadata = {
    ...metadata,
    repository: { ...metadata.repository, ...base },
  };
  if (metadata.agent !== undefined) {
    next.agent = {
      ...metadata.agent,
      appendSystemPrompt: withStackedWorkspaceInstruction(
        metadata.agent.appendSystemPrompt,
        effectiveBaseBranch,
        branch
      ),
    };
  }
  return next;
}
