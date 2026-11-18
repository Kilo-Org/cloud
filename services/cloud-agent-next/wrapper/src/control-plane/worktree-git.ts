import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import {
  worktreeBranchOperationResultSchema,
  type ControlPlaneWorktreeGitFrame,
  type WorktreeBranchOperationRequest,
  type WorktreeBranchOperationResult,
} from '../../../src/shared/worktree-git-operations.js';
import { managedGitHubPreparationGitArgs } from './repository-preparation.js';
import {
  createWorktreeGitExecutor,
  runWorktreeRestack,
  runWorktreeSync,
  WorktreeGitError,
} from '../control/worktree-git-operations.js';
import { isDirectoryRewriteActive, runDirectoryRewrite } from '../control/worktree-operations.js';

export type PreparedGitContext = {
  directory: string;
  /** The prepared route environment: per-worktree HOME, credential helper and profile env. */
  env: NodeJS.ProcessEnv;
  /** The route spec, used only for managed GitHub fetch arguments and the expected branch. */
  spec?: Pick<ControlPlaneRouteSpec, 'git' | 'createdOnPlatform' | 'branch'>;
};

export type ControlPlaneWorktreeGitDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  isPrepared: (sessionId: string) => boolean;
  /** The prepared result of preparation, or null while the route is not attached. */
  gitContext: (sessionId: string) => PreparedGitContext | null;
  /** Any live turn, including a sibling session, is a rewrite refusal. */
  hasActiveTurnInDirectory: (directory: string) => boolean;
  /** Prompt admission resumes when the rewrite releases the directory. */
  resumeDirectory?: (directory: string) => void;
  log?: (message: string) => void;
  runSync?: typeof runWorktreeSync;
  runRestack?: typeof runWorktreeRestack;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean
): ControlPlaneWrapperFrame {
  return { type: 'worktree.result', requestId, ok: false, error: { code, message, retryable } };
}

function managedArgs(context: PreparedGitContext): string[] {
  return context.spec === undefined ? [] : managedGitHubPreparationGitArgs(context.spec, 'fetch');
}

function refusedBeforeRun(
  operation: WorktreeBranchOperationRequest['operation'],
  reason: 'turn_running',
  branch: string | null,
  headSha: string
): WorktreeBranchOperationResult {
  return {
    status: 'refused',
    operation,
    branch,
    reason,
    message: 'A turn is running in this workspace; wait for it to finish',
    baseBranch: null,
    baseSha: null,
    previousRemoteSha: null,
    remoteSha: null,
    headSha,
  };
}

export function createControlPlaneWorktreeGit(deps: ControlPlaneWorktreeGitDeps): {
  handle(frame: ControlPlaneWorktreeGitFrame): Promise<void>;
} {
  const runSync = deps.runSync ?? runWorktreeSync;
  const runRestack = deps.runRestack ?? runWorktreeRestack;

  async function run(
    context: PreparedGitContext,
    request: WorktreeBranchOperationRequest
  ): Promise<WorktreeBranchOperationResult> {
    const configArgs = managedArgs(context);
    const executor = createWorktreeGitExecutor({
      directory: context.directory,
      env: context.env,
      configArgs,
    });
    if (deps.hasActiveTurnInDirectory(context.directory)) {
      const branch = await executor.currentBranch();
      const head = (await executor.tryResolve('HEAD')) ?? '0'.repeat(40);
      return refusedBeforeRun(request.operation, 'turn_running', branch, head);
    }
    const expectedBranch = context.spec?.branch;
    return request.operation === 'sync'
      ? runSync(executor, request, expectedBranch === undefined ? {} : { expectedBranch })
      : runRestack(executor, request, expectedBranch === undefined ? {} : { expectedBranch });
  }

  async function handle(frame: ControlPlaneWorktreeGitFrame): Promise<void> {
    const { requestId, session, payload } = frame;
    if (!deps.isPrepared(session.sessionId)) {
      deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
      return;
    }
    const context = deps.gitContext(session.sessionId);
    if (context === null) {
      deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
      return;
    }
    try {
      const result = await runDirectoryRewrite(context.directory, async () => {
        const outcome = await run(context, payload);
        return worktreeBranchOperationResultSchema.parse(outcome);
      });
      deps.emit({ type: 'worktree.result', requestId, ok: true, result });
    } catch (error) {
      if (messageOf(error) === 'worktree_deleting') {
        deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
        return;
      }
      if (error instanceof WorktreeGitError) {
        deps.emit(fail(requestId, error.code, error.message.slice(0, 4096), error.retryable));
        return;
      }
      deps.log?.(`worktree branch operation failed: ${messageOf(error)}`);
      deps.emit(fail(requestId, 'git_failed', messageOf(error).slice(0, 4096), true));
    } finally {
      // Prompt admission parked during the rewrite resumes here.
      if (!isDirectoryRewriteActive(context.directory)) deps.resumeDirectory?.(context.directory);
    }
  }

  return { handle };
}
