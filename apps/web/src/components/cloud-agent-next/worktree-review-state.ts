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
  destinationKiloSessionId: string | null;
  allowOlderCapture: boolean;
  delivery:
    | { phase: 'idle' }
    | { phase: 'preparing' }
    | { phase: 'sending' | 'unknown'; batch: FrozenReviewBatch };
  error?: string;
};

export type WorktreeReviewOutcome = WorktreeReviewSendResult;

export function worktreeReviewScopeKey(scope: WorktreeReviewScope): string {
  return JSON.stringify([scope.userId, scope.organizationId, scope.workspaceScope]);
}

export function createWorktreeReviewDraft(scope: WorktreeReviewScope): WorktreeReviewDraft {
  return {
    scope,
    comments: [],
    editor: null,
    destinationKiloSessionId: null,
    allowOlderCapture: false,
    delivery: { phase: 'idle' },
  };
}

export function hasPendingWorktreeReview(draft: WorktreeReviewDraft): boolean {
  return draft.comments.length > 0 || draft.editor !== null || draft.delivery.phase !== 'idle';
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

export function createWorktreeReviewStore() {
  let drafts: ReadonlyMap<string, WorktreeReviewDraft> = new Map();
  const listeners = new Set<() => void>();
  const getDraft = (scope: WorktreeReviewScope) =>
    drafts.get(worktreeReviewScopeKey(scope)) ?? createWorktreeReviewDraft(scope);
  const write = (draft: WorktreeReviewDraft) => {
    drafts = new Map(drafts).set(worktreeReviewScopeKey(draft.scope), draft);
    listeners.forEach(listener => listener());
  };
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
    setDestination(scope: WorktreeReviewScope, destinationKiloSessionId: string | null) {
      edit(scope, draft => ({ ...draft, destinationKiloSessionId, error: undefined }));
    },
    setAllowOlderCapture(scope: WorktreeReviewScope, allowOlderCapture: boolean) {
      edit(scope, draft => ({ ...draft, allowOlderCapture, error: undefined }));
    },
    setEditor(scope: WorktreeReviewScope, editor: WorktreeReviewEditor | null) {
      edit(scope, draft => {
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
      edit(scope, draft => {
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
      return edit(scope, draft => ({
        ...draft,
        comments: removeWorktreeReviewComment(draft.comments, id),
        editor: draft.editor?.commentId === id ? null : draft.editor,
        allowOlderCapture: false,
        error: undefined,
      }));
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
        write(createWorktreeReviewDraft(scope));
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
