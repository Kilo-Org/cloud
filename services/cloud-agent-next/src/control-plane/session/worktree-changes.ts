import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
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
import type { SandboxControlV2 } from '../sandbox/sandbox-do.js';
import type { SharedWorktreeChangesInput } from '../sandbox/worktree-changes.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { WorktreeRecovery } from '../../shared/worktree-changes-wire.js';

export type SharedWorktreeChangesPeer = Pick<
  SandboxControlV2,
  'getWorktreeChanges' | 'getWorktreeFile' | 'refreshWorktreeChanges' | 'getWorktreeRecovery'
>;

export type ControlPlaneWorktreeChangesDeps = {
  storage: DurableObjectStorage;
  sessionId: SessionId;
  eventQueries: EventQueries;
  broadcast: (event: StoredEvent) => void;
  getMetadata: () => SessionMetadata | null;
  /** The registered route directory, set at registration (spec §3). */
  getDirectory: () => string | undefined;
  getSharedPeer: (sandboxId: string) => SharedWorktreeChangesPeer | null;
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
  let seededWorktree: string | undefined;
  function context() {
    const metadata = deps.getMetadata();
    if (metadata === null) return null;
    const directory = deps.getDirectory() ?? metadata.workspace?.workspacePath;
    if (directory === undefined) return null;
    return worktreeChangesContext(metadata, directory);
  }

  function saveReadyEvent(revision: number): (() => void) | undefined {
    const payload = JSON.stringify({ revision });
    const timestamp = Date.now();
    const id = deps.eventQueries.insertUnique({
      executionId: '',
      sessionId: deps.sessionId,
      streamEventType: WORKTREE_CHANGES_READY_EVENT,
      payload,
      timestamp,
      entityId: `worktree-changes/${revision}`,
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
    saveSnapshotEvent: snapshot => saveReadyEvent(snapshot.revision),
    refreshSnapshot: async current => {
      if (!current.worktreeId) return undefined;
      return shared(current, (peer, input) => peer.refreshWorktreeChanges(input));
    },
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

  async function shared<T>(
    current: NonNullable<ReturnType<typeof context>>,
    operation: (peer: SharedWorktreeChangesPeer, input: SharedWorktreeChangesInput) => Promise<T>
  ): Promise<T> {
    const result = await withDORetry(
      () => {
        const peer = deps.getSharedPeer(current.sandboxId);
        if (!peer) throw new Error('Sandbox is not available');
        return peer;
      },
      peer =>
        operation(peer, {
          context: current,
          saved: seededWorktree === current.worktreeId ? undefined : manager.saved(),
        }),
      'sharedWorktreeChanges'
    );
    seededWorktree = current.worktreeId;
    return result;
  }

  return {
    ready(revision: number): void {
      saveReadyEvent(revision)?.();
    },
    async recovery(): Promise<WorktreeRecovery | undefined> {
      const current = context();
      if (current?.worktreeId)
        return shared(current, (peer, input) => peer.getWorktreeRecovery(input));
      return manager.recovery();
    },
    get(): Promise<GetWorktreeChangesOutput> {
      const current = context();
      if (current?.worktreeId)
        return shared(current, (peer, input) => peer.getWorktreeChanges(input));
      return manager.get();
    },
    async getFile(query: unknown): Promise<GetWorktreeFileOutput> {
      const current = context();
      if (current?.worktreeId)
        return shared(current, (peer, input) => peer.getWorktreeFile(input, query));
      return manager.getFile(query);
    },
    async refresh(): Promise<RefreshWorktreeChangesOutput> {
      const result = await manager.refresh();
      const current = context();
      if (current?.worktreeId && result.status !== 'refreshed') {
        const saved = await shared(current, (peer, input) => peer.getWorktreeChanges(input));
        return { ...result, snapshot: saved.snapshot };
      }
      return result;
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
