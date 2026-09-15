import type { QueryFunction, QueryKey, skipToken } from '@tanstack/react-query';
import type { SessionConfig } from '@kilocode/cloud-agent-sdk';
import { normalizeAlias } from './session-config';
import type {
  GetWorktreeChangesOutput,
  WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { preserveNewerWorktreeChanges } from './worktree-changes';
import {
  addWorktreeReviewComment,
  removeWorktreeReviewComment,
  sameWorktreeReviewCapture,
  sameWorktreeReviewScope,
  updateWorktreeReviewComment,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
  type WorktreeReviewResult,
} from './worktree-review';
import type { WorktreeReviewEditor } from './worktree-review-bindings';
import type {
  WorktreeReviewConfiguration,
  WorktreeReviewSendResult,
  WorktreeReviewSubmission,
} from './worktree-review-send';

export type WorktreeReviewScope = Pick<
  WorktreeReviewCapture,
  'userId' | 'organizationId' | 'workspaceScope'
>;

type FrozenReviewBatch = {
  destinationKiloSessionId: string;
  submission: WorktreeReviewSubmission;
};

export type WorktreeReviewDraft = {
  scope: WorktreeReviewScope;
  comments: readonly WorktreeReviewComment[];
  editor: WorktreeReviewEditor | null;
  overall: string;
  destinationKiloSessionId: string | null;
  allowOlderCapture: boolean;
  delivery:
    | { phase: 'idle' }
    | { phase: 'preparing' }
    | { phase: 'sending' | 'unknown'; batch: FrozenReviewBatch };
  error?: string;
};

export type WorktreeReviewOutcome = WorktreeReviewSendResult;

export type PersistedWorktreeReviewDraft = {
  version: 1;
  comments: readonly WorktreeReviewComment[];
  editor: WorktreeReviewEditor | null;
  overall: string;
  destinationKiloSessionId: string | null;
  allowOlderCapture: boolean;
};

export type WorktreeReviewPersistence = {
  load: (key: string) => Promise<PersistedWorktreeReviewDraft | null>;
  save: (key: string, value: PersistedWorktreeReviewDraft) => Promise<void> | void;
  clear: (key: string) => Promise<void> | void;
};

export type WorktreeReviewHydrationStatus = 'pending' | 'ready' | 'failed';

export const WORKTREE_REVIEW_PERSISTENCE_TIMEOUT_MS = 3_000;

type WorktreeReviewHydrationOverlay = {
  destinationKiloSessionId: string | null;
  overall: string;
};

export function worktreeReviewScopeKey(scope: WorktreeReviewScope): string {
  return JSON.stringify([scope.userId, scope.organizationId, scope.workspaceScope]);
}

export function createWorktreeReviewDraft(scope: WorktreeReviewScope): WorktreeReviewDraft {
  return {
    scope,
    comments: [],
    editor: null,
    overall: '',
    destinationKiloSessionId: null,
    allowOlderCapture: false,
    delivery: { phase: 'idle' },
  };
}

export function hasPendingWorktreeReview(draft: WorktreeReviewDraft): boolean {
  return (
    draft.comments.length > 0 ||
    draft.editor !== null ||
    draft.overall.trim().length > 0 ||
    draft.delivery.phase !== 'idle'
  );
}

export function getWorktreeReviewSourceSessionIds(draft: WorktreeReviewDraft | null): string[] {
  return [
    ...new Set([
      ...(draft?.comments.map(comment => comment.anchor.capture.sourceCloudAgentSessionId) ?? []),
      ...(draft?.editor ? [draft.editor.anchor.capture.sourceCloudAgentSessionId] : []),
    ]),
  ];
}

export function currentWorktreeReviewCapture(
  scope: WorktreeReviewScope,
  sourceCloudAgentSessionId: string,
  snapshot: WorktreeChangesSnapshot | null | undefined
): WorktreeReviewCapture | null {
  return snapshot
    ? {
        ...scope,
        sourceCloudAgentSessionId,
        revision: snapshot.revision,
        capturedAt: snapshot.capturedAt,
        comparison: snapshot.comparison,
      }
    : null;
}

export function worktreeReviewSavedReadOptions<TQueryKey extends QueryKey>(
  queryFn: QueryFunction<GetWorktreeChangesOutput, TQueryKey> | typeof skipToken | undefined
) {
  return {
    structuralSharing: preserveNewerWorktreeChanges,
    queryFn: async (context: Parameters<QueryFunction<GetWorktreeChangesOutput, TQueryKey>>[0]) => {
      if (typeof queryFn !== 'function') throw new Error('The saved capture is unavailable.');
      const result = await queryFn(context);
      if (!result.snapshot) throw new Error('The saved capture is unavailable.');
      return result;
    },
  };
}

export function snapshotWorktreeReviewConfiguration(
  destinationKiloSessionId: string,
  activeKiloSessionId: string | null | undefined,
  sessionConfig:
    | Partial<Pick<SessionConfig, 'mode' | 'model' | 'variant' | 'runtimeAgents'>>
    | null
    | undefined
): WorktreeReviewConfiguration | undefined {
  if (destinationKiloSessionId !== activeKiloSessionId || !sessionConfig) return undefined;
  const agent = sessionConfig.runtimeAgents?.find(
    candidate => candidate.slug === sessionConfig.mode
  );
  const pinnedModel = agent?.model?.trim() || undefined;
  const model = pinnedModel ?? sessionConfig.model;
  if (!model?.trim()) return undefined;
  return Object.freeze({
    mode: normalizeAlias(sessionConfig.mode) || 'code',
    model,
    variant: pinnedModel
      ? agent?.variant?.trim() || undefined
      : (sessionConfig.variant ?? undefined),
  });
}

function sameEditorAnchor(left: WorktreeReviewEditor, right: WorktreeReviewEditor): boolean {
  return (
    left.commentId === right.commentId &&
    left.anchor.path === right.anchor.path &&
    sameWorktreeReviewCapture(left.anchor.capture, right.anchor.capture) &&
    left.anchor.range.side === right.anchor.range.side &&
    left.anchor.range.startLine === right.anchor.range.startLine &&
    left.anchor.range.endLine === right.anchor.range.endLine
  );
}

function persistedDraft(draft: WorktreeReviewDraft): PersistedWorktreeReviewDraft {
  return {
    version: 1,
    comments: draft.comments,
    editor: draft.editor,
    overall: draft.overall,
    destinationKiloSessionId: draft.destinationKiloSessionId,
    allowOlderCapture: draft.allowOlderCapture,
  };
}

function hasPersistedDraftContent(value: PersistedWorktreeReviewDraft): boolean {
  return (
    value.comments.length > 0 ||
    value.editor !== null ||
    value.overall.trim().length > 0 ||
    value.destinationKiloSessionId !== null ||
    value.allowOlderCapture
  );
}

function draftFromPersisted(
  scope: WorktreeReviewScope,
  persisted: PersistedWorktreeReviewDraft
): WorktreeReviewDraft {
  return {
    scope,
    comments: persisted.comments,
    editor: persisted.editor,
    overall: persisted.overall,
    destinationKiloSessionId: persisted.destinationKiloSessionId,
    allowOlderCapture: persisted.allowOlderCapture,
    delivery: { phase: 'idle' },
  };
}

function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs = WORKTREE_REVIEW_PERSISTENCE_TIMEOUT_MS
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Worktree review persistence timed out.')),
      timeoutMs
    );
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createWorktreeReviewStore(persistence?: WorktreeReviewPersistence) {
  let drafts: ReadonlyMap<string, WorktreeReviewDraft> = new Map();
  const listeners = new Set<() => void>();
  const hydration = new Map<string, WorktreeReviewHydrationStatus>();
  const hydrationGeneration = new Map<string, number>();
  const persistGeneration = new Map<string, number>();
  const hydrationOverlays = new Map<string, WorktreeReviewHydrationOverlay>();
  const getHydrationOverlay = (key: string) =>
    hydrationOverlays.get(key) ?? {
      destinationKiloSessionId: null,
      overall: '',
    };

  const notify = () => {
    listeners.forEach(listener => listener());
  };

  const touch = () => {
    drafts = new Map(drafts);
    notify();
  };

  const getDraft = (scope: WorktreeReviewScope) => {
    const key = worktreeReviewScopeKey(scope);
    ensureHydration(scope);
    return drafts.get(key) ?? createWorktreeReviewDraft(scope);
  };

  const invalidatePersistedDraft = (key: string) => {
    persistGeneration.set(key, (persistGeneration.get(key) ?? 0) + 1);
  };

  const persistSnapshot = (key: string, generation: number): Promise<void> => {
    if (!persistence) return Promise.resolve();
    const current = drafts.get(key);
    const value = current ? persistedDraft(current) : null;
    const operation =
      value && hasPersistedDraftContent(value)
        ? persistence.save(key, value)
        : persistence.clear(key);
    return Promise.resolve(operation).then(() => {
      if ((persistGeneration.get(key) ?? 0) === generation) return;
      return persistSnapshot(key, persistGeneration.get(key) ?? 0);
    });
  };

  const savePersistedDraft = (draft: WorktreeReviewDraft) => {
    if (!persistence || hydration.get(worktreeReviewScopeKey(draft.scope)) !== 'ready') return;
    const key = worktreeReviewScopeKey(draft.scope);
    const generation = persistGeneration.get(key) ?? 0;
    try {
      void persistSnapshot(key, generation).catch(() => undefined);
    } catch {
      // Persistence is best effort; the in-memory draft remains authoritative.
    }
  };

  const write = (draft: WorktreeReviewDraft, persist = true) => {
    const key = worktreeReviewScopeKey(draft.scope);
    drafts = new Map(drafts).set(key, draft);
    if (persist) savePersistedDraft(draft);
    notify();
  };

  const failHydration = (key: string, generation: number) => {
    if (hydrationGeneration.get(key) !== generation) return;
    hydration.set(key, 'failed');
    touch();
  };

  const hydrate = async (scope: WorktreeReviewScope, key: string, generation: number) => {
    if (!persistence) return;
    let restored: PersistedWorktreeReviewDraft | null;
    try {
      restored = await withTimeout(persistence.load(key));
    } catch {
      failHydration(key, generation);
      return;
    }
    if (hydrationGeneration.get(key) !== generation) return;
    const current = drafts.get(key);
    const base = restored ? draftFromPersisted(scope, restored) : createWorktreeReviewDraft(scope);
    const overlay = hydrationOverlays.get(key);
    const merged = {
      ...base,
      destinationKiloSessionId: overlay?.destinationKiloSessionId ?? base.destinationKiloSessionId,
      overall: overlay?.overall.trim() ? overlay.overall : base.overall,
      allowOlderCapture: current?.allowOlderCapture || base.allowOlderCapture,
      delivery: { phase: 'idle' as const },
      error: undefined,
    };
    hydration.set(key, 'ready');
    hydrationOverlays.delete(key);
    write(merged);
  };

  function ensureHydration(scope: WorktreeReviewScope) {
    if (!persistence) return;
    const key = worktreeReviewScopeKey(scope);
    if (hydration.has(key)) return;
    const generation = (hydrationGeneration.get(key) ?? 0) + 1;
    hydrationGeneration.set(key, generation);
    hydration.set(key, 'pending');
    void hydrate(scope, key, generation);
  }

  const edit = (
    scope: WorktreeReviewScope,
    update: (draft: WorktreeReviewDraft) => WorktreeReviewDraft
  ) => {
    const draft = getDraft(scope);
    if (draft.delivery.phase !== 'idle') return false;
    write(update(draft));
    return true;
  };

  return {
    getSnapshot: () => drafts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getDraft,
    getHydration(key: string): WorktreeReviewHydrationStatus {
      return hydration.get(key) ?? (persistence ? 'pending' : 'ready');
    },
    setDestination(scope: WorktreeReviewScope, destinationKiloSessionId: string | null) {
      if (persistence) {
        const key = worktreeReviewScopeKey(scope);
        const overlay = getHydrationOverlay(key);
        hydrationOverlays.set(key, {
          ...overlay,
          destinationKiloSessionId,
        });
      }
      edit(scope, draft => ({ ...draft, destinationKiloSessionId, error: undefined }));
    },
    setAllowOlderCapture(scope: WorktreeReviewScope, allowOlderCapture: boolean) {
      edit(scope, draft => ({ ...draft, allowOlderCapture, error: undefined }));
    },
    setOverall(scope: WorktreeReviewScope, overall: string) {
      if (persistence) {
        const key = worktreeReviewScopeKey(scope);
        const overlay = getHydrationOverlay(key);
        hydrationOverlays.set(key, { ...overlay, overall });
      }
      edit(scope, draft => ({ ...draft, overall, error: undefined }));
    },
    setEditor(scope: WorktreeReviewScope, editor: WorktreeReviewEditor | null) {
      ensureHydration(scope);
      const key = worktreeReviewScopeKey(scope);
      if (hydration.get(key) === 'pending') return false;
      return edit(scope, draft => {
        if (editor && !sameWorktreeReviewScope(scope, editor.anchor.capture)) return draft;
        if (draft.editor && editor && !sameEditorAnchor(draft.editor, editor)) {
          return {
            ...draft,
            error: 'Save or discard the open comment before selecting other lines.',
          };
        }
        return { ...draft, editor, error: undefined };
      });
    },
    saveEditor(scope: WorktreeReviewScope, newCommentId: string) {
      ensureHydration(scope);
      if (hydration.get(worktreeReviewScopeKey(scope)) === 'pending') return false;
      return edit(scope, draft => {
        const editor = draft.editor;
        if (!editor) return draft;
        const result = editor.commentId
          ? updateWorktreeReviewComment(draft.comments, editor.commentId, editor.text)
          : addWorktreeReviewComment(draft.comments, {
              id: newCommentId,
              anchor: editor.anchor,
              text: editor.text,
            });
        return result.ok
          ? {
              ...draft,
              comments: result.value,
              editor: null,
              allowOlderCapture: false,
              error: undefined,
            }
          : { ...draft, error: result.error };
      });
    },
    removeComment(scope: WorktreeReviewScope, id: string) {
      ensureHydration(scope);
      if (hydration.get(worktreeReviewScopeKey(scope)) === 'pending') return false;
      return edit(scope, draft => ({
        ...draft,
        comments: removeWorktreeReviewComment(draft.comments, id),
        editor: draft.editor?.commentId === id ? null : draft.editor,
        allowOlderCapture: false,
        error: undefined,
      }));
    },
    replacePathComments(
      scope: WorktreeReviewScope,
      path: string,
      comments: readonly WorktreeReviewComment[]
    ) {
      ensureHydration(scope);
      if (hydration.get(worktreeReviewScopeKey(scope)) === 'pending') return false;
      return edit(scope, draft => ({
        ...draft,
        comments: [
          ...draft.comments.filter(comment => comment.anchor.path !== path),
          ...comments.filter(comment => comment.anchor.path === path),
        ],
        error: undefined,
      }));
    },
    discardDraft(scope: WorktreeReviewScope) {
      if (getDraft(scope).delivery.phase !== 'idle') return false;
      invalidatePersistedDraft(worktreeReviewScopeKey(scope));
      write(createWorktreeReviewDraft(scope));
      return true;
    },
    async send({
      scope,
      activeKiloSessionId,
      activeSessionConfig,
      prepare,
      submit,
      isScopeCurrent,
      onAccepted,
    }: {
      scope: WorktreeReviewScope;
      activeKiloSessionId?: string | null;
      activeSessionConfig?: SessionConfig | null;
      prepare: (
        draft: WorktreeReviewDraft,
        configuration: WorktreeReviewConfiguration | undefined
      ) => Promise<WorktreeReviewResult<WorktreeReviewSubmission>>;
      submit: (submission: WorktreeReviewSubmission) => Promise<WorktreeReviewOutcome>;
      isScopeCurrent: () => boolean;
      onAccepted: (destinationKiloSessionId: string, delivery: 'sent' | 'queued') => void;
    }): Promise<WorktreeReviewOutcome | null> {
      const draft = getDraft(scope);
      if (draft.delivery.phase === 'preparing' || draft.delivery.phase === 'sending') return null;
      if (!isScopeCurrent()) return null;
      let batch: FrozenReviewBatch;
      if (draft.delivery.phase === 'unknown') {
        batch = draft.delivery.batch;
        write({ ...draft, delivery: { phase: 'sending', batch }, error: undefined });
      } else {
        if (draft.editor || !draft.destinationKiloSessionId || draft.comments.length === 0) {
          write({
            ...draft,
            error: draft.editor
              ? 'Save or discard the open comment before sending the review.'
              : 'Add feedback and choose a destination chat before sending.',
          });
          return null;
        }
        const configuration = snapshotWorktreeReviewConfiguration(
          draft.destinationKiloSessionId,
          activeKiloSessionId,
          activeSessionConfig
        );
        write({ ...draft, delivery: { phase: 'preparing' }, error: undefined });
        let prepared: WorktreeReviewResult<WorktreeReviewSubmission>;
        try {
          prepared = await prepare(draft, configuration);
        } catch {
          prepared = {
            ok: false,
            error: 'Could not prepare this review. Check access and try again.',
          };
        }
        if (!prepared.ok || !isScopeCurrent()) {
          write({
            ...draft,
            delivery: { phase: 'idle' },
            error: prepared.ok
              ? 'The account or organization changed. Review was not sent.'
              : prepared.error,
          });
          return null;
        }
        batch = {
          destinationKiloSessionId: draft.destinationKiloSessionId,
          submission: prepared.value,
        };
        write({ ...draft, delivery: { phase: 'sending', batch }, error: undefined });
      }
      let outcome: WorktreeReviewOutcome;
      try {
        outcome = await submit(batch.submission);
      } catch {
        outcome = {
          status: 'unknown',
          error: 'Delivery could not be confirmed. Retry to check this same review batch.',
        };
      }
      if (outcome.status === 'accepted') {
        const key = worktreeReviewScopeKey(scope);
        invalidatePersistedDraft(key);
        if (persistence) {
          try {
            await withTimeout(Promise.resolve().then(() => persistence.clear(key)));
          } catch {
            // An IDB failure must not block an accepted review or leave its memory state locked.
          }
        }
        hydrationGeneration.set(key, (hydrationGeneration.get(key) ?? 0) + 1);
        hydration.set(key, 'ready');
        hydrationOverlays.delete(key);
        write(createWorktreeReviewDraft(scope), false);
        if (isScopeCurrent()) onAccepted(batch.destinationKiloSessionId, outcome.delivery);
      } else {
        write({
          ...draft,
          delivery: outcome.status === 'unknown' ? { phase: 'unknown', batch } : { phase: 'idle' },
          error: outcome.error,
        });
      }
      return outcome;
    },
  };
}
