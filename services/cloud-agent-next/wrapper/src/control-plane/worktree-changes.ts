import type {
  ControlPlaneWrapperFrame,
  ControlPlaneWorktreeRequestFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  sessionGitSummaryResultSchema,
  worktreeSnapshotCaptureSchema,
  type SessionGitSummaryPayload,
  type SessionGitSummaryResult,
  type WorktreeSnapshotCapture,
} from '../../../src/shared/worktree-changes-wire.js';
import { groupedWorktreeSnapshotSchema } from '../../../src/shared/worktree-groups.js';
import {
  collectWorktreeChanges,
  collectWorktreeSnapshot,
  type WorktreeCaptureGitEnvironment,
} from '../control/worktree-changes.js';
import {
  createWorktreeGitExecutor,
  refreshChangesRemotes,
  WorktreeGitError,
} from '../control/worktree-git-operations.js';
import { runDirectoryOperation } from '../control/worktree-operations.js';
import { captureRootSnapshots } from './root-changes.js';
import { managedGitHubPreparationGitArgs } from './repository-preparation.js';
import { hasEnvironmentRoots, type RouteRoot } from './workspace-roots.js';
import type { PreparedGitContext } from './worktree-git.js';

/**
 * Handles the Sandbox DO's worktree-change requests inside the control-plane
 * wrapper (spec §10). The capture itself is the shared, pure
 * `control/worktree-changes.ts`; this adapter owns the frame in/out plus the
 * guards the legacy handler had: only an attached route may capture, captures
 * for one directory are fenced against a concurrent delete (`runDirectoryOperation`
 * registers pending work and rejects while the directory is deleting; it is not
 * a serializer), and the result is validated before it is reported.
 *
 * Before capturing, the base branch is refreshed with the prepared route
 * environment. A missing base falls back to the default branch with a notice.
 * Other fetch failures are reported as retryable.
 */
export type ControlPlaneWorktreeChangesDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  /** The preparation manager's readiness for a session route (spec §7). */
  isPrepared: (sessionId: string) => boolean;
  /** The git roots of a prepared route. A route with no entry, or one legacy root, has one repository. */
  roots?: (sessionId: string) => readonly RouteRoot[] | undefined;
  /** The prepared route environment and spec, or null while not attached. */
  gitContext?: (sessionId: string) => PreparedGitContext | null;
  refreshRemotes?: typeof refreshChangesRemotes;
  log?: (message: string) => void;
  captureSnapshot?: (
    directory: string,
    payload: SessionGitSummaryPayload,
    environment?: WorktreeCaptureGitEnvironment
  ) => Promise<WorktreeSnapshotCapture>;
  captureChanges?: (
    directory: string,
    payload: SessionGitSummaryPayload,
    environment?: WorktreeCaptureGitEnvironment
  ) => Promise<SessionGitSummaryResult>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function environmentFor(
  context: PreparedGitContext | null
): WorktreeCaptureGitEnvironment | undefined {
  if (context === null) return undefined;
  return {
    env: context.env,
    ...(context.spec === undefined
      ? {}
      : { configArgs: managedGitHubPreparationGitArgs(context.spec, 'fetch') }),
  };
}

export function createControlPlaneWorktreeChanges(deps: ControlPlaneWorktreeChangesDeps): {
  handle(frame: ControlPlaneWorktreeRequestFrame): Promise<void>;
} {
  const captureSnapshot =
    deps.captureSnapshot ??
    ((directory, payload, environment) =>
      collectWorktreeSnapshot(directory, payload, undefined, undefined, environment));
  const captureChanges =
    deps.captureChanges ??
    ((directory, payload, environment) =>
      collectWorktreeChanges(directory, payload, undefined, undefined, environment));
  const refreshRemotes = deps.refreshRemotes ?? refreshChangesRemotes;

  function fail(
    requestId: string,
    code: string,
    message: string,
    retryable: boolean
  ): ControlPlaneWrapperFrame {
    return { type: 'worktree.result', requestId, ok: false, error: { code, message, retryable } };
  }

  async function handle(frame: ControlPlaneWorktreeRequestFrame): Promise<void> {
    const { requestId, session, payload } = frame;
    if (!deps.isPrepared(session.sessionId)) {
      deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
      return;
    }
    try {
      await runDirectoryOperation(session.directory, async () => {
        const roots = deps.roots?.(session.sessionId);
        if (roots !== undefined && hasEnvironmentRoots(roots)) {
          await handleGrouped(frame, roots);
          return;
        }
        const context = deps.gitContext?.(session.sessionId) ?? null;
        const environment = environmentFor(context);
        let effectivePayload = payload;
        let baseRefFallback: { requested: string; used: string } | undefined;
        if (context !== null) {
          const executor = createWorktreeGitExecutor({
            directory: context.directory,
            env: context.env,
            ...(context.spec === undefined
              ? {}
              : { configArgs: managedGitHubPreparationGitArgs(context.spec, 'fetch') }),
          });
          const refreshed = await refreshRemotes(executor, {
            ...(payload.baseRef === undefined ? {} : { baseRef: payload.baseRef }),
          });
          if (refreshed.request.baseRef !== undefined) {
            effectivePayload = { ...payload, baseRef: refreshed.request.baseRef };
          }
          baseRefFallback = refreshed.baseRefFallback;
        }
        const captured =
          frame.type === 'worktree.snapshot'
            ? await captureSnapshot(session.directory, effectivePayload, environment)
            : await captureChanges(session.directory, effectivePayload, environment);
        if (frame.type === 'worktree.snapshot') {
          const snapshot = captured as WorktreeSnapshotCapture;
          const enriched: WorktreeSnapshotCapture = {
            ...snapshot,
            summary: {
              ...snapshot.summary,
              comparison: {
                ...snapshot.summary.comparison,
                ...(baseRefFallback === undefined ? {} : { baseRefFallback }),
              },
            },
          };
          const parsed = worktreeSnapshotCaptureSchema.safeParse(enriched);
          if (!parsed.success || !resultMatches(parsed.data.summary, effectivePayload)) {
            deps.emit(fail(requestId, 'protocol_error', 'Invalid worktree result', false));
            return;
          }
          deps.emit({ type: 'worktree.result', requestId, ok: true, result: parsed.data });
        } else {
          const summary = captured as SessionGitSummaryResult;
          const enriched: SessionGitSummaryResult = {
            ...summary,
            comparison: {
              ...summary.comparison,
              ...(baseRefFallback === undefined ? {} : { baseRefFallback }),
            },
          };
          const parsed = sessionGitSummaryResultSchema.safeParse(enriched);
          if (!parsed.success || !resultMatches(parsed.data, effectivePayload)) {
            deps.emit(fail(requestId, 'protocol_error', 'Invalid worktree result', false));
            return;
          }
          deps.emit({ type: 'worktree.result', requestId, ok: true, result: parsed.data });
        }
      });
    } catch (error) {
      if (messageOf(error) === 'worktree_deleting') {
        deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
        return;
      }
      if (error instanceof WorktreeGitError) {
        deps.log?.(`worktree capture refresh failed: ${messageOf(error)}`);
        deps.emit(fail(requestId, error.code, messageOf(error).slice(0, 4096), error.retryable));
        return;
      }
      deps.log?.(`worktree capture failed: ${messageOf(error)}`);
      deps.emit(fail(requestId, 'capture_failed', messageOf(error).slice(0, 4096), true));
    }
  }

  /**
   * A V2 route answers a snapshot with one capture for each repository, each
   * against its own base. It has no summary-only capture: that is the fallback of
   * a wrapper that predates snapshots, which a V2 route never runs on.
   */
  async function handleGrouped(
    frame: ControlPlaneWorktreeRequestFrame,
    roots: readonly RouteRoot[]
  ): Promise<void> {
    const { requestId, payload } = frame;
    if (frame.type !== 'worktree.snapshot') {
      deps.emit(fail(requestId, 'unsupported', 'A multi-repository route has no summary', false));
      return;
    }
    const grouped = await captureRootSnapshots({
      roots,
      revision: payload.revision,
      capture: captureSnapshot,
    });
    const parsed = groupedWorktreeSnapshotSchema.safeParse(grouped);
    if (
      !parsed.success ||
      parsed.data.repositories.some(group => group.capture.summary.revision !== payload.revision)
    ) {
      deps.emit(fail(requestId, 'protocol_error', 'Invalid worktree result', false));
      return;
    }
    deps.emit({ type: 'worktree.result', requestId, ok: true, result: parsed.data });
  }

  function resultMatches(
    summary: { revision: number; comparison: { baseRef: string } },
    payload: SessionGitSummaryPayload
  ): boolean {
    return (
      summary.revision === payload.revision &&
      (payload.baseRef === undefined || summary.comparison.baseRef === payload.baseRef)
    );
  }

  return { handle };
}
