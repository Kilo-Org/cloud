import { z } from 'zod';
import {
  WORKTREE_CHANGES_SCHEMA_VERSION,
  worktreeChangesCaptureSchema,
  worktreeChangesSnapshotSchema,
  worktreeFileQuerySchema,
  worktreeFileRecordSchema,
  worktreeSnapshotCaptureSchema,
  type GetWorktreeChangesOutput,
  type GetWorktreeFileOutput,
  type RefreshWorktreeChangesOutput,
  type WorktreeChangesCaptureRequest,
  type WorktreeChangesSnapshot,
  type WorktreeFileRecord,
  type WorktreeSnapshotCapture,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { getSandboxProvider } from '../persistence/session-metadata.js';
import type { ResponseFrame, SessionRequestIdentity } from '../shared/sandbox-control-protocol.js';
import { WORKTREE_CHANGED_EVENT } from '../shared/worktree-changes-wire.js';

export const WORKTREE_CHANGES_KEY = 'worktree_changes';
export const WORKTREE_FILE_PREFIX = 'worktree_file:';

export type WorktreeChangesContext = {
  session: SessionRequestIdentity;
  ownerId: string;
  orgId?: string;
  sandboxId: string;
  worktreeId?: NonNullable<SessionMetadata['workspace']>['worktreeId'];
  provider: 'cloudflare' | 'vercel';
  providerRuntime?: NonNullable<SessionMetadata['workspace']>['providerRuntime'];
  repository: { type: string; source: string };
  baseRef?: string;
};

type CaptureTrigger = { generation: number; context?: WorktreeChangesContext };

type WorktreeChangesDependencies = {
  storage: {
    kv: {
      get(key: string): unknown;
      put(key: string, value: WorktreeChangesSnapshot | WorktreeFileRecord): void;
      delete(key: string): boolean;
      list(options: { prefix: string }): Iterable<[string, unknown]>;
    };
    transactionSync<T>(callback: () => T): T;
  };
  saveSnapshotEvent?(snapshot: WorktreeChangesSnapshot): (() => void) | undefined;
  readContext(): Promise<WorktreeChangesContext | null>;
  requestCapture(
    context: WorktreeChangesContext,
    payload: WorktreeChangesCaptureRequest,
    operation: 'session.git.snapshot' | 'session.git.summary'
  ): Promise<ResponseFrame>;
  waitUntil(promise: Promise<unknown>): void;
};

const idleStatusSchema = z.object({ status: z.object({ type: z.literal('idle') }) });

export function worktreeChangesBaseRef(branch: string | undefined): string | undefined {
  if (branch === undefined) return undefined;
  return `refs/remotes/origin/${branch}`;
}

export function worktreeChangesContext(
  metadata: SessionMetadata,
  directory: string
): WorktreeChangesContext | null {
  const sandboxId = metadata.workspace?.sandboxId;
  const kiloSessionId = metadata.auth.kiloSessionId;
  const repository = metadata.repository;
  if (!sandboxId || !kiloSessionId || !repository || !directory) return null;
  return {
    session: { sessionId: metadata.identity.sessionId, kiloSessionId, directory },
    ownerId: metadata.identity.userId,
    orgId: metadata.identity.orgId,
    sandboxId,
    worktreeId: metadata.workspace?.worktreeId,
    provider: getSandboxProvider(metadata),
    providerRuntime: metadata.workspace?.providerRuntime,
    repository: {
      type: repository.type,
      source: repository.type === 'github' ? repository.repo : repository.url,
    },
    baseRef: worktreeChangesBaseRef(repository.upstreamBranch),
  };
}

function sameContext(left: WorktreeChangesContext, right: WorktreeChangesContext | null): boolean {
  return right !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function createWorktreeChanges(deps: WorktreeChangesDependencies) {
  let generation = 0;
  let revision = 0;
  let suppressed = false;
  let preparing = false;
  let inFlight: Promise<RefreshWorktreeChangesOutput> | undefined;
  let pending: CaptureTrigger | undefined;
  let pendingInterruption: { generation: number; context: WorktreeChangesContext } | undefined;

  function readSnapshot(): WorktreeChangesSnapshot | null {
    const parsed = worktreeChangesSnapshotSchema.safeParse(
      deps.storage.kv.get(WORKTREE_CHANGES_KEY)
    );
    return parsed.success &&
      new Set(parsed.data.files.map(file => file.path)).size === parsed.data.files.length
      ? parsed.data
      : null;
  }

  function replaceSnapshot(snapshot: WorktreeChangesSnapshot, files: WorktreeFileRecord[]): void {
    const broadcast = deps.storage.transactionSync(() => {
      const keys = new Set(files.map(file => `${WORKTREE_FILE_PREFIX}${file.path}`));
      for (const [key] of deps.storage.kv.list({ prefix: WORKTREE_FILE_PREFIX })) {
        if (!keys.has(key)) deps.storage.kv.delete(key);
      }
      for (const file of files) {
        deps.storage.kv.put(`${WORKTREE_FILE_PREFIX}${file.path}`, file);
      }
      deps.storage.kv.put(WORKTREE_CHANGES_KEY, snapshot);
      return deps.saveSnapshotEvent?.(snapshot);
    });
    broadcast?.();
  }

  async function capture(trigger: CaptureTrigger): Promise<RefreshWorktreeChangesOutput> {
    let snapshot: WorktreeChangesSnapshot | null = null;
    try {
      snapshot = readSnapshot();
      if (trigger.generation !== generation) return { status: 'failed', snapshot };
      if (suppressed || preparing) return { status: 'offline', snapshot };
      const context = await deps.readContext();
      if (trigger.generation !== generation) return { status: 'failed', snapshot };
      if (!context) return { status: 'offline', snapshot };
      if (trigger.context && !sameContext(trigger.context, context)) {
        return { status: 'failed', snapshot };
      }
      revision = Math.max(revision, snapshot?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) return { status: 'failed', snapshot };
      const requestedRevision = revision;
      const payload = {
        revision: requestedRevision,
        ...(context.baseRef ? { baseRef: context.baseRef } : {}),
      };
      let response = await deps.requestCapture(context, payload, 'session.git.snapshot');
      if (trigger.generation !== generation) return { status: 'failed', snapshot };
      const legacy = !response.ok && response.error?.code === 'unknown_operation';
      if (legacy) {
        response = await deps.requestCapture(context, payload, 'session.git.summary');
        if (trigger.generation !== generation) return { status: 'failed', snapshot };
      }
      if (!response.ok) {
        return { status: response.error?.code === 'not_ready' ? 'offline' : 'failed', snapshot };
      }
      let captured: WorktreeSnapshotCapture;
      if (legacy) {
        const parsed = worktreeChangesCaptureSchema.safeParse(response.result);
        if (!parsed.success) return { status: 'failed', snapshot };
        captured = { summary: parsed.data, files: [] };
      } else {
        const parsed = worktreeSnapshotCaptureSchema.safeParse(response.result);
        if (!parsed.success) return { status: 'failed', snapshot };
        captured = parsed.data;
      }
      if (
        captured.summary.revision !== requestedRevision ||
        new Set(captured.summary.files.map(file => file.path)).size !==
          captured.summary.files.length ||
        (context.baseRef !== undefined && captured.summary.comparison.baseRef !== context.baseRef)
      ) {
        return { status: 'failed', snapshot };
      }
      const saved = worktreeChangesSnapshotSchema.safeParse({
        ...captured.summary,
        schemaVersion: WORKTREE_CHANGES_SCHEMA_VERSION,
        capturedAt: new Date().toISOString(),
      });
      if (!saved.success) return { status: 'failed', snapshot };
      const current = await deps.readContext();
      if (
        suppressed ||
        preparing ||
        trigger.generation !== generation ||
        captured.summary.revision !== revision ||
        !sameContext(context, current)
      ) {
        return { status: 'failed', snapshot };
      }
      replaceSnapshot(saved.data, captured.files);
      return { status: 'refreshed', snapshot: saved.data };
    } catch {
      return { status: 'failed', snapshot };
    }
  }

  function start(trigger: CaptureTrigger): Promise<RefreshWorktreeChangesOutput> {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      try {
        let next = trigger;
        while (true) {
          const result = await capture(next);
          const trailing = pending;
          pending = undefined;
          if (!trailing) return result;
          next = trailing;
        }
      } finally {
        inFlight = undefined;
      }
    });
    return inFlight;
  }

  function schedule(context: WorktreeChangesContext): void {
    if (suppressed || preparing) return;
    const trigger = { generation, context };
    if (inFlight) pending = trigger;
    deps.waitUntil(start(trigger));
  }

  function invalidate(): void {
    generation++;
    pending = undefined;
    pendingInterruption = undefined;
  }

  return {
    async get(): Promise<GetWorktreeChangesOutput> {
      return { snapshot: readSnapshot() };
    },

    getFile(input: unknown): GetWorktreeFileOutput {
      const query = worktreeFileQuerySchema.safeParse(input);
      if (!query.success) throw new Error('Invalid worktree file query');
      if (suppressed) return { status: 'not_captured' };
      return deps.storage.transactionSync((): GetWorktreeFileOutput => {
        const snapshot = readSnapshot();
        if (!snapshot) return { status: 'not_captured' };
        const listed = snapshot.files.find(file => file.path === query.data.path);
        if (!listed) return { status: 'no_longer_listed', currentRevision: snapshot.revision };
        if (snapshot.revision !== query.data.expectedRevision) {
          return { status: 'stale', currentRevision: snapshot.revision };
        }
        const parsed = worktreeFileRecordSchema.safeParse(
          deps.storage.kv.get(`${WORKTREE_FILE_PREFIX}${query.data.path}`)
        );
        if (
          !parsed.success ||
          parsed.data.revision !== snapshot.revision ||
          parsed.data.path !== query.data.path ||
          (parsed.data.content.status === 'available' &&
            parsed.data.content.source !==
              (listed.status === 'deleted' ? 'deleted-original' : 'current'))
        ) {
          return { status: 'not_captured' };
        }
        return {
          status: parsed.data.diff.status,
          file: parsed.data,
          capturedAt: snapshot.capturedAt,
          comparison: snapshot.comparison,
        };
      });
    },

    refresh(): Promise<RefreshWorktreeChangesOutput> {
      return start({ generation });
    },

    beginPreparation(): number {
      invalidate();
      preparing = true;
      return generation;
    },

    finishPreparation(preparationGeneration: number): void {
      if (preparationGeneration === generation) preparing = false;
    },

    attached(preparationGeneration: number, context: WorktreeChangesContext | null): void {
      if (preparationGeneration !== generation || suppressed) return;
      preparing = false;
      if (context) schedule(context);
    },

    markInterrupted(context: WorktreeChangesContext | null): void {
      if (context && !suppressed && !preparing) pendingInterruption = { generation, context };
    },

    onEvent(
      context: WorktreeChangesContext | null,
      eventKiloSessionId: string | undefined,
      type: string,
      properties: Record<string, unknown>
    ): void {
      if (!context || eventKiloSessionId !== context.session.kiloSessionId) return;
      if (type === WORKTREE_CHANGED_EVENT) {
        schedule(context);
        return;
      }
      const terminal =
        type === 'session.turn.close' ||
        type === 'session.error' ||
        type === 'session.message.outcome';
      const interruptionSettled =
        pendingInterruption?.generation === generation &&
        sameContext(pendingInterruption.context, context) &&
        (type === 'session.idle' ||
          (type === 'session.status' && idleStatusSchema.safeParse(properties).success));
      if (!terminal && !interruptionSettled) return;
      pendingInterruption = undefined;
      schedule(context);
    },

    suppress(): void {
      suppressed = true;
      invalidate();
    },

    purge(): void {
      deps.storage.kv.delete(WORKTREE_CHANGES_KEY);
      for (const [key] of deps.storage.kv.list({ prefix: WORKTREE_FILE_PREFIX })) {
        deps.storage.kv.delete(key);
      }
    },
  };
}
