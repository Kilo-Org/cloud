import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
  WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { EventQueries } from '../../session/queries/index.js';
import { ingestKiloSessionId } from '../../sandbox-session/control-plane-ingest.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import {
  createWorktreeChanges,
  worktreeChangesContext,
} from '../../sandbox-session/worktree-changes.js';
import type {
  ControlPlaneControlResult,
  ControlPlaneWorktreeCaptureInput,
} from '../../shared/control-plane-protocol.js';
import { WORKTREE_CHANGES_READY_EVENT } from '../../shared/worktree-changes-wire.js';
import type { SessionId } from '../../types/ids.js';
import type { StoredEvent } from '../../websocket/types.js';

export type ControlPlaneWorktreeChangesDeps = {
  storage: DurableObjectStorage;
  sessionId: SessionId;
  eventQueries: EventQueries;
  broadcast: (event: StoredEvent) => void;
  getMetadata: () => SessionMetadata | null;
  /** The registered route directory, set at registration (spec §3). */
  getDirectory: () => string | undefined;
  /** Forwards one capture request to the Sandbox DO (spec §10). */
  capture: (
    sandboxId: string,
    input: ControlPlaneWorktreeCaptureInput
  ) => Promise<ControlPlaneControlResult>;
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * The V2 Session DO's worktree-changes projection. It reuses the transport-
 * neutral manager (`sandbox-session/worktree-changes.ts`) and supplies the new
 * control-plane request path plus the shared event log (spec §10, plan B10).
 */
export function createControlPlaneWorktreeChanges(deps: ControlPlaneWorktreeChangesDeps) {
  function context() {
    const metadata = deps.getMetadata();
    if (metadata === null) return null;
    const directory = deps.getDirectory() ?? metadata.workspace?.workspacePath;
    if (directory === undefined) return null;
    return worktreeChangesContext(metadata, directory);
  }

  function saveSnapshotEvent(snapshot: WorktreeChangesSnapshot): (() => void) | undefined {
    const payload = JSON.stringify({ revision: snapshot.revision });
    const timestamp = Date.now();
    const id = deps.eventQueries.insertUnique({
      executionId: '',
      sessionId: deps.sessionId,
      streamEventType: WORKTREE_CHANGES_READY_EVENT,
      payload,
      timestamp,
      entityId: `worktree-changes/${snapshot.revision}`,
    });
    if (id === null) return undefined;
    return () => {
      try {
        deps.broadcast({
          id,
          execution_id: '',
          session_id: deps.sessionId,
          stream_event_type: WORKTREE_CHANGES_READY_EVENT,
          payload,
          timestamp,
        });
      } catch {
        // Best effort: a missed broadcast is replayed from the event log.
      }
    };
  }

  const manager = createWorktreeChanges({
    storage: deps.storage,
    readContext: async () => context(),
    saveSnapshotEvent,
    requestCapture: async (worktreeContext, payload, operation) => {
      const sandboxId = worktreeContext.sandboxId;
      try {
        const result = await deps.capture(sandboxId, {
          operation,
          session: worktreeContext.session,
          payload,
        });
        return result.ok
          ? { ok: true, result: result.result }
          : {
              ok: false,
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
            };
      } catch {
        // An unreachable Sandbox DO is "no information" (offline), not a
        // failed capture: the previous snapshot is kept and retried later.
        return {
          ok: false,
          code: 'not_ready',
          message: 'Worktree capture failed',
          retryable: true,
        };
      }
    },
    waitUntil: deps.waitUntil,
  });

  return {
    get(): Promise<GetWorktreeChangesOutput> {
      return manager.get();
    },
    getFile(input: unknown): GetWorktreeFileOutput {
      return manager.getFile(input);
    },
    refresh(): Promise<RefreshWorktreeChangesOutput> {
      return manager.refresh();
    },
    /**
     * A `session.*` event carries its own kilo session id; child-session events
     * (a different id) must never start a capture for this session.
     */
    onEvent(type: string, properties: Record<string, unknown>): void {
      manager.onEvent(context(), ingestKiloSessionId(type, properties), type, properties);
    },
    /** A wrapper outcome has no session id of its own; it belongs to this route. */
    onOutcome(properties: Record<string, unknown>): void {
      const current = context();
      manager.onEvent(
        current,
        current?.session.kiloSessionId,
        'session.message.outcome',
        properties
      );
    },
    beginPreparation(): number {
      return manager.beginPreparation();
    },
    finishPreparation(preparationGeneration: number): void {
      manager.finishPreparation(preparationGeneration);
    },
    attached(preparationGeneration: number): void {
      manager.attached(preparationGeneration, context());
    },
    markInterrupted(): void {
      manager.markInterrupted(context());
    },
    suppress(): void {
      manager.suppress();
    },
  };
}

export type ControlPlaneWorktreeChanges = ReturnType<typeof createControlPlaneWorktreeChanges>;
