import type {
  ControlPlaneKiloRequestFrame,
  ControlPlaneNativeOperation,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  CONTROL_PLANE_KILO_MESSAGE_LIMIT,
  CONTROL_PLANE_KILO_RESULT_MAX_BYTES,
} from '../../../src/shared/control-plane-protocol.js';
import type { HarnessReads } from './harness.js';
import type { SnapshotFileDiff } from '@kilocode/sdk/v2';
import {
  worktreeSnapshotCaptureSchema,
  type SessionGitSummaryPayload,
  type WorktreeSnapshotCapture,
} from '../../../src/shared/worktree-changes-wire.js';
import { collectWorktreeSnapshot } from '../control/worktree-changes.js';
import { WorktreeFileCaptureError } from '../control/worktree-file-capture.js';
import { runDirectoryOperation } from '../control/worktree-operations.js';

/**
 * Handles the Sandbox DO's allowlisted native read requests inside the
 * control-plane wrapper (spec §10). The wrapper owns no policy here: Cloud has
 * already authorized the session and admission stays on the Session DO. This
 * adapter resolves the prepared route's runtime, performs exactly one named
 * native read, bounds the result, and emits one `kilo.result`. It never accepts
 * a URL, method or path, so hosted live routing cannot become a sandbox tunnel.
 */

/** Bound on one native read, below the Sandbox DO's 30 s request budget. */
export const KILO_REQUEST_TIMEOUT_MS = 20_000;

export type ControlPlaneKiloRequestsDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  /** Runtime identity of a prepared route, or null while it is not attached. */
  preparedRoute: (sessionId: string) => { runtimeKey: string; directory: string } | null;
  /** The live native client for one runtime key, or null when it is gone. */
  clientFor: (runtimeKey: string) => HarnessReads | null;
  captureSnapshot?: (
    directory: string,
    payload: SessionGitSummaryPayload,
    signal: AbortSignal
  ) => Promise<WorktreeSnapshotCapture>;
  log?: (message: string) => void;
  timeoutMs?: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(operation: ControlPlaneNativeOperation, value: unknown): unknown {
  if (operation.name !== 'session.messages') return value;
  if (!Array.isArray(value)) return value;
  const limit = operation.limit ?? CONTROL_PLANE_KILO_MESSAGE_LIMIT;
  return value.length <= limit ? value : value.slice(value.length - limit);
}

export function createControlPlaneKiloRequests(deps: ControlPlaneKiloRequestsDeps): {
  handle(frame: ControlPlaneKiloRequestFrame): Promise<void>;
} {
  const timeoutMs = deps.timeoutMs ?? KILO_REQUEST_TIMEOUT_MS;
  const captureSnapshot =
    deps.captureSnapshot ??
    ((directory, payload, signal) =>
      collectWorktreeSnapshot(directory, payload, undefined, signal));

  function fail(
    requestId: string,
    code: string,
    message: string,
    retryable: boolean
  ): ControlPlaneWrapperFrame {
    return { type: 'kilo.result', requestId, ok: false, error: { code, message, retryable } };
  }

  async function run(
    client: HarnessReads,
    directory: string,
    kiloSessionId: string,
    operation: ControlPlaneNativeOperation,
    signal: AbortSignal
  ): Promise<unknown> {
    switch (operation.name) {
      case 'session.get':
        return client.getSessionDetails(kiloSessionId, directory, signal);
      case 'session.messages':
        return client.getRecentSessionMessages(kiloSessionId, directory, signal);
      case 'session.status': {
        const statuses = await client.getSessionStatuses(directory, signal);
        const status = statuses[kiloSessionId];
        return status === undefined ? {} : { [kiloSessionId]: status };
      }
      case 'session.todo':
        return client.getSessionTodos(kiloSessionId, directory, signal);
      case 'session.diff': {
        const nativeDiff = await client.getSessionDiff(kiloSessionId, directory, signal);
        if (!Array.isArray(nativeDiff))
          throw new Error('Native session diff returned an invalid array');
        if (nativeDiff.length > 0) return nativeDiff;
        // Cloud runtimes disable Kilo snapshots; reuse the bounded worktree patches instead.
        return runDirectoryOperation(directory, async () => {
          const snapshot = worktreeSnapshotCaptureSchema.parse(
            await captureSnapshot(directory, { revision: 1, baseRef: operation.baseRef }, signal)
          );
          if (snapshot.summary.truncated) throw new WorktreeFileCaptureError('too_large');
          const records = new Map(snapshot.files.map(file => [file.path, file]));
          return snapshot.summary.files.map((file): SnapshotFileDiff => {
            const record = records.get(file.path);
            if (!record) throw new Error('Worktree diff is incomplete');
            if (record.diff.status === 'omitted' && record.diff.reason !== 'binary') {
              throw new WorktreeFileCaptureError(record.diff.reason);
            }
            return {
              file: file.path,
              additions: file.additions,
              deletions: file.deletions,
              status: file.status,
              patch: record.diff.status === 'available' ? record.diff.patch : '',
            };
          });
        });
      }
      case 'question.list': {
        const questions = await client.getQuestions(directory, signal);
        return questions.filter(question => question.sessionID === kiloSessionId);
      }
      case 'permission.list': {
        const permissions = await client.getPermissions(directory, signal);
        return permissions.filter(permission => permission.sessionID === kiloSessionId);
      }
    }
  }

  async function handle(frame: ControlPlaneKiloRequestFrame): Promise<void> {
    const { requestId, session, operation } = frame;
    const route = deps.preparedRoute(session.sessionId);
    if (route === null || route.directory !== session.directory) {
      deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
      return;
    }
    const client = deps.clientFor(route.runtimeKey);
    if (client === null) {
      deps.emit(fail(requestId, 'not_ready', 'Native runtime is not available', false));
      return;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const result = bounded(
        operation,
        await run(client, route.directory, session.kiloSessionId, operation, signal)
      );
      const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
      if (bytes > CONTROL_PLANE_KILO_RESULT_MAX_BYTES) {
        deps.emit(
          fail(requestId, 'too_large', 'Native response exceeds the public response budget', false)
        );
        return;
      }
      deps.emit({ type: 'kilo.result', requestId, ok: true, result });
    } catch (error) {
      if (signal.aborted) {
        deps.emit(fail(requestId, 'timeout', 'Native request timed out', true));
        return;
      }
      if (
        error instanceof WorktreeFileCaptureError &&
        ['too_large', 'line_limit', 'budget_exhausted'].includes(error.reason)
      ) {
        deps.emit(
          fail(requestId, 'too_large', 'Native response exceeds the public response budget', false)
        );
        return;
      }
      if (messageOf(error) === 'worktree_deleting') {
        deps.emit(fail(requestId, 'not_ready', 'Session directory is not attached', false));
        return;
      }
      deps.log?.(`native request ${operation.name} failed: ${messageOf(error)}`);
      deps.emit(fail(requestId, 'native_failed', messageOf(error).slice(0, 4096), true));
    }
  }

  return { handle };
}
