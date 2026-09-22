'use client';

import { createStore } from 'jotai/vanilla';
import { MiniDb } from 'jotai-minidb';
import { z } from 'zod';
import {
  getWorktreeReviewAnchorError,
  getWorktreeReviewCommentsError,
  MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
  MAX_WORKTREE_REVIEW_COMMENTS,
  worktreeReviewAnchorSchema,
  worktreeReviewCommentSchema,
  sameWorktreeReviewScope,
  type WorktreeReviewAnchor,
} from './worktree-review';
import {
  WORKTREE_REVIEW_PERSISTENCE_TIMEOUT_MS,
  type PersistedWorktreeReviewDraft,
  type WorktreeReviewPersistence,
  type WorktreeReviewScope,
} from './worktree-review-state';

const persistedEditorSchema = z
  .object({
    commentId: z.string().min(1).max(1_024).optional(),
    anchor: worktreeReviewAnchorSchema,
    text: z.string().max(MAX_WORKTREE_REVIEW_COMMENT_LENGTH),
  })
  .strict();

const persistedDraftSchema = z
  .object({
    version: z.literal(1),
    comments: z.array(worktreeReviewCommentSchema).max(MAX_WORKTREE_REVIEW_COMMENTS),
    editor: persistedEditorSchema.nullable(),
    overall: z.string().max(MAX_WORKTREE_REVIEW_COMMENT_LENGTH),
    destinationKiloSessionId: z.string().min(1).max(1_024).nullable(),
    allowOlderCapture: z.boolean(),
  })
  .strict();

const persistenceScopeKeySchema = z.tuple([
  z.string().min(1).max(1_024),
  z.string().min(1).max(1_024).nullable(),
  z.string().min(1).max(1_024),
]);

function parsePersistenceScopeKey(key: string): WorktreeReviewScope | null {
  try {
    const parsed = persistenceScopeKeySchema.safeParse(JSON.parse(key));
    if (!parsed.success) return null;
    return {
      userId: parsed.data[0],
      organizationId: parsed.data[1] ?? undefined,
      workspaceScope: parsed.data[2],
    };
  } catch {
    return null;
  }
}

function normalizeAnchor(anchor: z.infer<typeof worktreeReviewAnchorSchema>): WorktreeReviewAnchor {
  return {
    ...anchor,
    capture: {
      ...anchor.capture,
      organizationId: anchor.capture.organizationId,
    },
  };
}

function normalizeDraft(draft: z.infer<typeof persistedDraftSchema>): PersistedWorktreeReviewDraft {
  return {
    ...draft,
    comments: draft.comments.map(comment => ({
      ...comment,
      anchor: normalizeAnchor(comment.anchor),
    })),
    editor: draft.editor ? { ...draft.editor, anchor: normalizeAnchor(draft.editor.anchor) } : null,
  };
}

export type WorktreeReviewPersistenceOptions = {
  timeoutMs?: number;
  createDb?: () => MiniDb<PersistedWorktreeReviewDraft>;
  store?: ReturnType<typeof createStore>;
};

function createNoopPersistence(): WorktreeReviewPersistence {
  return {
    load: async () => null,
    save: async () => {},
    clear: async () => {},
  };
}

function withTimeout<T>(operation: () => PromiseLike<T> | T, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Worktree review persistence timed out.')),
      timeoutMs
    );
    try {
      Promise.resolve(operation()).then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

export function createWorktreeReviewPersistence(
  options: WorktreeReviewPersistenceOptions = {}
): WorktreeReviewPersistence {
  if (typeof window === 'undefined') return createNoopPersistence();

  const timeoutMs = options.timeoutMs ?? WORKTREE_REVIEW_PERSISTENCE_TIMEOUT_MS;
  const atomStore = options.store ?? createStore();
  let failed = false;
  let failureLogged = false;
  const logFailure = () => {
    if (failureLogged) return;
    failureLogged = true;
    console.error('[worktree-review] IndexedDB persistence unavailable; using in-memory drafts.');
  };
  const fail = () => {
    failed = true;
    logFailure();
  };
  let database: MiniDb<PersistedWorktreeReviewDraft>;
  try {
    database =
      options.createDb?.() ??
      new MiniDb<PersistedWorktreeReviewDraft>({ name: 'kilocode-worktree-review-drafts' });
  } catch {
    fail();
    return createNoopPersistence();
  }

  const initialization = withTimeout(
    () =>
      new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error('Worktree review persistence initialization timed out.'));
        }, timeoutMs);
        const check = () => {
          try {
            if (atomStore.get(database.items) !== undefined) {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            }
          } catch (error) {
            clearTimeout(timer);
            unsubscribe();
            reject(error);
          }
        };
        try {
          atomStore.get(database.items);
          unsubscribe = atomStore.sub(database.items, check);
          check();
        } catch (error) {
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        }
      }),
    timeoutMs
  ).then(
    () => true,
    () => {
      fail();
      return false;
    }
  );

  async function run<T>(operation: () => PromiseLike<T> | T): Promise<T | undefined> {
    if (failed || !(await initialization)) return undefined;
    try {
      return await withTimeout(operation, timeoutMs);
    } catch {
      fail();
      return undefined;
    }
  }

  return {
    async load(key) {
      const value = await run(() => atomStore.get(database.item(key)));
      if (value === undefined) return null;
      const parsed = persistedDraftSchema.safeParse(value);
      if (!parsed.success) {
        await run(() => atomStore.set(database.delete, key));
        return null;
      }
      const normalized = normalizeDraft(parsed.data);
      const scope = parsePersistenceScopeKey(key);
      if (
        !scope ||
        getWorktreeReviewCommentsError(normalized.comments) ||
        normalized.comments.some(
          comment => !sameWorktreeReviewScope(scope, comment.anchor.capture)
        ) ||
        (normalized.editor && !sameWorktreeReviewScope(scope, normalized.editor.anchor.capture)) ||
        (normalized.editor && getWorktreeReviewAnchorError(normalized.editor.anchor)) ||
        (normalized.editor?.commentId !== undefined &&
          !normalized.comments.some(comment => comment.id === normalized.editor?.commentId))
      ) {
        await run(() => atomStore.set(database.delete, key));
        return null;
      }
      return normalized;
    },
    async save(key, value) {
      await run(() => atomStore.set(database.set, key, value));
    },
    async clear(key) {
      await run(() => atomStore.set(database.delete, key));
    },
  };
}
