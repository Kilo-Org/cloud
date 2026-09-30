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
import {
  collectWorktreeChanges,
  collectWorktreeSnapshot,
} from '../control/worktree-changes.js';
import { runDirectoryOperation } from '../control/worktree-operations.js';

/**
 * Handles the Sandbox DO's worktree-change requests inside the control-plane
 * wrapper (spec §10). The capture itself is the shared, pure
 * `control/worktree-changes.ts`; this adapter owns the frame in/out plus the
 * guards the legacy handler had: only an attached route may capture, captures
 * for one directory are fenced against a concurrent delete (`runDirectoryOperation`
 * registers pending work and rejects while the directory is deleting; it is not
 * a serializer), and the result is validated before it is reported.
 */
export type ControlPlaneWorktreeChangesDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  /** The preparation manager's readiness for a session route (spec §7). */
  isPrepared: (sessionId: string) => boolean;
  log?: (message: string) => void;
  captureSnapshot?: (
    directory: string,
    payload: SessionGitSummaryPayload
  ) => Promise<WorktreeSnapshotCapture>;
  captureChanges?: (
    directory: string,
    payload: SessionGitSummaryPayload
  ) => Promise<SessionGitSummaryResult>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createControlPlaneWorktreeChanges(
  deps: ControlPlaneWorktreeChangesDeps
): { handle(frame: ControlPlaneWorktreeRequestFrame): Promise<void> } {
  const captureSnapshot = deps.captureSnapshot ?? collectWorktreeSnapshot;
  const captureChanges = deps.captureChanges ?? collectWorktreeChanges;

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
        const captured =
          frame.type === 'worktree.snapshot'
            ? await captureSnapshot(session.directory, payload)
            : await captureChanges(session.directory, payload);
        if (frame.type === 'worktree.snapshot') {
          const parsed = worktreeSnapshotCaptureSchema.safeParse(captured);
          if (!parsed.success || !resultMatches(parsed.data.summary, payload)) {
            deps.emit(fail(requestId, 'protocol_error', 'Invalid worktree result', false));
            return;
          }
          deps.emit({ type: 'worktree.result', requestId, ok: true, result: parsed.data });
        } else {
          const parsed = sessionGitSummaryResultSchema.safeParse(captured);
          if (!parsed.success || !resultMatches(parsed.data, payload)) {
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
      deps.log?.(`worktree capture failed: ${messageOf(error)}`);
      deps.emit(
        fail(requestId, 'capture_failed', messageOf(error).slice(0, 4096), true)
      );
    }
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
