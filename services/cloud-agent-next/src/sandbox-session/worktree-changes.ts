import { z } from 'zod';
import {
  WORKTREE_CHANGES_SCHEMA_VERSION,
  worktreeChangesCaptureSchema,
  worktreeChangesSnapshotSchema,
  type GetWorktreeChangesOutput,
  type RefreshWorktreeChangesOutput,
  type WorktreeChangesCaptureRequest,
  type WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { getSandboxProvider } from '../persistence/session-metadata.js';
import type { ResponseFrame, SessionRequestIdentity } from '../shared/sandbox-control-protocol.js';
import { WORKTREE_CHANGED_EVENT } from '../shared/worktree-changes-wire.js';

export const WORKTREE_CHANGES_KEY = 'worktree_changes';

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
    get(key: string): Promise<unknown>;
    put(key: string, value: WorktreeChangesSnapshot): Promise<void>;
  };
  readContext(): Promise<WorktreeChangesContext | null>;
  requestCapture(
    context: WorktreeChangesContext,
    payload: WorktreeChangesCaptureRequest
  ): Promise<ResponseFrame>;
  waitUntil(promise: Promise<unknown>): void;
};

const idleStatusSchema = z.object({ status: z.object({ type: z.literal('idle') }) });

export function worktreeChangesBaseRef(branch: string | undefined): string | undefined {
  if (branch === undefined) return undefined;
  if (branch.startsWith('refs/remotes/')) return branch;
  if (branch.startsWith('remotes/')) return `refs/${branch}`;
  if (branch.startsWith('origin/')) return `refs/remotes/${branch}`;
  if (branch.startsWith('refs/heads/')) {
    return `refs/remotes/origin/${branch.slice('refs/heads/'.length)}`;
  }
  if (branch.startsWith('refs/')) throw new Error('Unsupported worktree comparison ref');
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

  async function readSnapshot(): Promise<WorktreeChangesSnapshot | null> {
    const parsed = worktreeChangesSnapshotSchema.safeParse(
      await deps.storage.get(WORKTREE_CHANGES_KEY)
    );
    return parsed.success ? parsed.data : null;
  }

  async function capture(trigger: CaptureTrigger): Promise<RefreshWorktreeChangesOutput> {
    let snapshot: WorktreeChangesSnapshot | null = null;
    try {
      snapshot = await readSnapshot();
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
      const response = await deps.requestCapture(context, {
        revision: requestedRevision,
        ...(context.baseRef ? { baseRef: context.baseRef } : {}),
      });
      if (trigger.generation !== generation) return { status: 'failed', snapshot };
      if (!response.ok) {
        return { status: response.error?.code === 'not_ready' ? 'offline' : 'failed', snapshot };
      }
      const parsed = worktreeChangesCaptureSchema.safeParse(response.result);
      if (
        !parsed.success ||
        parsed.data.revision !== requestedRevision ||
        (context.baseRef !== undefined && parsed.data.comparison.baseRef !== context.baseRef)
      ) {
        return { status: 'failed', snapshot };
      }
      const saved = worktreeChangesSnapshotSchema.safeParse({
        ...parsed.data,
        schemaVersion: WORKTREE_CHANGES_SCHEMA_VERSION,
        capturedAt: new Date().toISOString(),
      });
      if (!saved.success) return { status: 'failed', snapshot };
      const current = await deps.readContext();
      if (
        suppressed ||
        preparing ||
        trigger.generation !== generation ||
        parsed.data.revision !== revision ||
        !sameContext(context, current)
      ) {
        return { status: 'failed', snapshot };
      }
      await deps.storage.put(WORKTREE_CHANGES_KEY, saved.data);
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
      return { snapshot: await readSnapshot() };
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
  };
}
