import {
  worktreeChangesSnapshotSchema,
  worktreeFileIdentity,
  worktreeFileRecordSchema,
  type WorktreeChangesSnapshot,
  type WorktreeFileRecord,
  type WorktreeRecovery,
  type RefreshWorktreeChangesOutput,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  createWorktreeChanges,
  WORKTREE_CHANGES_KEY,
  WORKTREE_FILE_PREFIX,
  WORKTREE_RECOVERY_KEY,
  type WorktreeChangesContext,
} from '../../sandbox-session/worktree-changes.js';
import type {
  ControlPlaneControlResult,
  ControlPlaneWorktreeCaptureInput,
} from '../../shared/control-plane-protocol.js';
import { WORKTREE_DELETION_PREFIX } from './worktree-deletion.js';

export type SharedWorktreeChangesInput = {
  context: WorktreeChangesContext;
  saved?: {
    snapshot: WorktreeChangesSnapshot;
    files: WorktreeFileRecord[];
    recovery?: WorktreeRecovery;
  };
};

/** The marker of a session that reads the worktree's changes and gets its ready notifications. */
export function worktreeSubscriberKey(worktreeId: string, sessionId: string): string {
  return `worktree_changes/${worktreeId}/subscribers/${sessionId}`;
}

export function createSharedWorktreeChanges(deps: {
  storage: DurableObjectStorage;
  capture(input: ControlPlaneWorktreeCaptureInput): Promise<ControlPlaneControlResult>;
  onSnapshot(context: WorktreeChangesContext, revision: number): void;
}) {
  const captures = new Map<
    string,
    {
      promise: Promise<RefreshWorktreeChangesOutput>;
      pending?: SharedWorktreeChangesInput;
    }
  >();

  function manager(input: SharedWorktreeChangesInput) {
    const { context } = input;
    if (!context.worktreeId) throw new Error('Shared worktree changes require a worktree');
    const prefix = `worktree_changes/${context.worktreeId}/`;
    const deleted = () =>
      deps.storage.kv.get(`${WORKTREE_DELETION_PREFIX}${context.worktreeId}`) !== undefined;
    const storage = {
      kv: {
        get: (key: string) => deps.storage.kv.get(`${prefix}${key}`),
        put: (key: string, value: WorktreeChangesSnapshot | WorktreeFileRecord) =>
          deps.storage.kv.put(`${prefix}${key}`, value),
        delete: (key: string) => deps.storage.kv.delete(`${prefix}${key}`),
        list: (options: { prefix: string }) =>
          Array.from(
            deps.storage.kv.list({ prefix: `${prefix}${options.prefix}` }),
            ([key, value]): [string, unknown] => [key.slice(prefix.length), value]
          ),
      },
      transactionSync: <T>(callback: () => T) => deps.storage.transactionSync(callback),
    };
    const previous = worktreeChangesSnapshotSchema.safeParse(storage.kv.get(WORKTREE_CHANGES_KEY));
    if (!deleted() && input.saved) {
      const saved = input.saved;
      const snapshot = worktreeChangesSnapshotSchema.parse(saved.snapshot);
      const canPromote =
        storage.kv.get(WORKTREE_CHANGES_KEY) === undefined ||
        (deps.storage.kv.get(`${prefix}source`) === 'migration' &&
          previous.success &&
          Date.parse(snapshot.capturedAt) > Date.parse(previous.data.capturedAt));
      if (canPromote) {
        const revision = Math.max(
          snapshot.revision,
          previous.success ? previous.data.revision + 1 : 1
        );
        if (!Number.isSafeInteger(revision)) throw new Error('Worktree revision exhausted');
        const files = saved.files
          .map(file => worktreeFileRecordSchema.parse(file))
          .filter(file =>
            snapshot.files.some(
              listed =>
                worktreeFileIdentity(listed) === worktreeFileIdentity(file) &&
                listed.revision === file.revision
            )
          );
        storage.transactionSync(() => {
          for (const [key] of storage.kv.list({ prefix: WORKTREE_FILE_PREFIX })) {
            storage.kv.delete(key);
          }
          for (const file of files) {
            storage.kv.put(`${WORKTREE_FILE_PREFIX}${worktreeFileIdentity(file)}`, {
              ...file,
              revision,
            });
          }
          storage.kv.put(WORKTREE_CHANGES_KEY, {
            ...snapshot,
            revision,
            files: snapshot.files.map(file => ({ ...file, revision })),
          });
          if (saved.recovery === undefined) {
            deps.storage.kv.delete(`${prefix}${WORKTREE_RECOVERY_KEY}`);
          } else {
            deps.storage.kv.put(`${prefix}${WORKTREE_RECOVERY_KEY}`, {
              revision,
              recovery: saved.recovery,
            });
          }
          deps.storage.kv.put(`${prefix}source`, 'migration');
        });
        deps.onSnapshot(context, revision);
      } else if (previous.success && snapshot.revision > previous.data.revision) {
        const revision = snapshot.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('Worktree revision exhausted');
        storage.kv.put(WORKTREE_CHANGES_KEY, { ...previous.data, revision });
        deps.onSnapshot(context, revision);
      }
    }
    return createWorktreeChanges({
      storage,
      readContext: async () => context,
      saveSnapshotEvent: snapshot => {
        deps.storage.kv.put(`${prefix}source`, 'live');
        return () => deps.onSnapshot(context, snapshot.revision);
      },
      requestCapture: async (_context, payload, operation) => {
        if (deleted())
          return { ok: false, code: 'not_ready', message: 'Worktree deleted', retryable: false };
        const result = await deps.capture({ operation, session: context.session, payload });
        if (deleted())
          return { ok: false, code: 'not_ready', message: 'Worktree deleted', retryable: false };
        const current = worktreeChangesSnapshotSchema.safeParse(
          storage.kv.get(WORKTREE_CHANGES_KEY)
        );
        if (result.ok && current.success && current.data.revision >= payload.revision) {
          return {
            ok: false,
            code: 'stale',
            message: 'Worktree snapshot advanced during capture',
            retryable: true,
          };
        }
        return result.ok ? result : { ok: false, ...result.error };
      },
      waitUntil: () => {},
    });
  }

  return {
    get: (input: SharedWorktreeChangesInput) => manager(input).get(),
    getFile: (input: SharedWorktreeChangesInput, query: unknown) => manager(input).getFile(query),
    recovery: (input: SharedWorktreeChangesInput) => manager(input).recovery(),
    async refresh(input: SharedWorktreeChangesInput) {
      const key = input.context.worktreeId;
      if (!key) throw new Error('Shared worktree changes require a worktree');
      const existing = captures.get(key);
      if (existing) {
        existing.pending = input;
        return existing.promise;
      }
      const initial = manager(input);
      const entry: {
        promise: Promise<RefreshWorktreeChangesOutput>;
        pending?: SharedWorktreeChangesInput;
      } = {
        promise: Promise.resolve().then(async () => {
          try {
            let next = initial;
            while (true) {
              const result = await next.refresh();
              if (!entry.pending) return result;
              next = manager(entry.pending);
              entry.pending = undefined;
            }
          } finally {
            captures.delete(key);
          }
        }),
      };
      captures.set(key, entry);
      return entry.promise;
    },
    purge(worktreeId: string) {
      for (const [key] of deps.storage.kv.list({ prefix: `worktree_changes/${worktreeId}/` })) {
        deps.storage.kv.delete(key);
      }
    },
  };
}
