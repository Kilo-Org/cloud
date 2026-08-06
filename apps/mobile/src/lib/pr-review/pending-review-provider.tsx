import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import { clearDraft, flushDraft, loadDraft, saveDraft } from '@/lib/persist/drafts';

// One queued inline comment in the pending review. The composer fills
// this in when the user taps "Add to review"; the submit sheet drains
// the whole list into one `submitReview` batch call.
//
// `commitSha` records the PR head SHA at the time the comment was
// queued so the submit sheet can flag "may be outdated" if the head
// moves between queue and submit. Submission itself always uses the
// LATEST head SHA (per the S3 contract) — a per-item 422 surfaces
// inline so the user can decide whether to retry or drop the comment.
export type PendingReviewItem = {
  id: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  body: string;
  commitSha: string;
};

function isPendingReviewItem(value: unknown): value is PendingReviewItem {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.path === 'string' &&
    (item.side === 'LEFT' || item.side === 'RIGHT') &&
    typeof item.line === 'number' &&
    (item.startLine === undefined || typeof item.startLine === 'number') &&
    typeof item.body === 'string' &&
    typeof item.commitSha === 'string'
  );
}

/**
 * Runtime shape guard for a persisted pending-review draft. Passed to
 * `loadDraft` so a valid-JSON value that is not a comment array (or holds a
 * malformed item) is discarded as corrupt instead of entering the queue.
 */
export function isPendingReviewItemArray(value: unknown): value is PendingReviewItem[] {
  return Array.isArray(value) && value.every(item => isPendingReviewItem(item));
}

type PendingReviewContextValue = {
  items: PendingReviewItem[];
  addComment: (item: PendingReviewItem) => void;
  updateComment: (id: string, body: string) => void;
  removeComment: (id: string) => void;
  clear: () => void;
};

const PendingReviewContext = createContext<PendingReviewContextValue | undefined>(undefined);

type PendingReviewProviderProps = {
  readonly children: ReactNode;
  /**
   * Authenticated user id. Persistence is skipped until it is known; with an
   * unknown id the provider works memory-only (no hydrate, no persist).
   */
  readonly userId?: string;
  /**
   * Draft entity key under `draft:<userId>` (e.g. `pr-review:<owner>/<repo>#<n>`).
   * The provider is memory-only when absent.
   */
  readonly draftEntityKey?: string;
};

/**
 * Owns the pending-review comment queue and persists it as a durable draft
 * (scope `draft:<userId>`, entity key `pr-review:<owner>/<repo>#<number>`),
 * so queued comments survive process kill and come back on the next visit.
 *
 * Hydration: on mount the stored items load and merge into the in-memory
 * list, THEN `hydrated` flips true. The persistence effect writes ONLY after
 * hydration, so a slow load can never be overwritten by the initial empty
 * list (first-write guard). The layout mounts the provider with a key of
 * `entity:user`, so any entity or account change remounts it and both the
 * in-memory items and the hydration state die with the old instance; the
 * hydration effect also carries an `isActive` cleanup flag so a load that
 * resolves after unmount never applies.
 */
export function PendingReviewProvider({
  children,
  userId,
  draftEntityKey,
}: PendingReviewProviderProps) {
  const [items, setItems] = useState<PendingReviewItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Guards hydration against a result that resolves after unmount, after a
  // key change, or after an explicit clear: every effect run captures the
  // current generation and every cleanup (unmount or a superseding run) bumps
  // it, so a stale load never applies. `clear()` bumps the generation too, so
  // a late hydration can never merge old stored comments back into the queue
  // after a successful submit or discard (refs dodge the flow narrowing that
  // makes a local `let active` read as always-truthy to type-aware lint).
  const hydrationGenerationRef = useRef(0);
  useEffect(() => {
    hydrationGenerationRef.current += 1;
    const generation = hydrationGenerationRef.current;
    if (!userId || !draftEntityKey) {
      return undefined;
    }
    void (async () => {
      try {
        const restored = await loadDraft(userId, draftEntityKey, isPendingReviewItemArray);
        if (hydrationGenerationRef.current !== generation) {
          return;
        }
        if (isPendingReviewItemArray(restored) && restored.length > 0) {
          setItems(previous => mergePendingReviewItems(previous, restored));
        }
        setHydrated(true);
      } catch {
        // loadDraft reports storage failures to Sentry and resolves null;
        // this belt-and-braces catch keeps hydration from hanging on an
        // unexpected rejection — the queue starts empty (start-empty state).
        if (hydrationGenerationRef.current === generation) {
          setHydrated(true);
        }
      }
    })();
    return () => {
      hydrationGenerationRef.current += 1;
    };
  }, [userId, draftEntityKey]);

  // First-write guard: the persistence effect writes only once `hydrated`
  // is true. An empty queue clears the persisted entry (an empty list has
  // nothing worth storing) — this is what makes `removeComment`-to-empty
  // and the submit-success `clear()` durable.
  useEffect(() => {
    if (!hydrated || !userId || !draftEntityKey) {
      return;
    }
    if (items.length === 0) {
      void clearDraft(userId, draftEntityKey);
      return;
    }
    saveDraft(userId, draftEntityKey, items);
  }, [items, hydrated, userId, draftEntityKey]);

  // Flush the debounced save when the app leaves `active` and on unmount so
  // a backgrounded-then-killed app (or navigating away) keeps the last edit.
  useEffect(() => {
    if (!userId || !draftEntityKey) {
      return undefined;
    }
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState !== 'active') {
        void flushDraft(userId, draftEntityKey);
      }
    });
    return () => {
      subscription.remove();
      void flushDraft(userId, draftEntityKey);
    };
  }, [userId, draftEntityKey]);

  const addComment = useCallback((item: PendingReviewItem) => {
    setItems(previous => [...previous, item]);
  }, []);

  const updateComment = useCallback((id: string, body: string) => {
    setItems(previous => previous.map(item => (item.id === id ? { ...item, body } : item)));
  }, []);

  const removeComment = useCallback((id: string) => {
    setItems(previous => previous.filter(item => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    // A successful clear invalidates any in-flight hydration: a late load
    // must not merge the old stored comments back into the queue after the
    // user submitted the review or discarded the queue. Mark hydration
    // settled too, so a later addComment persists even when the invalidated
    // load never resolves.
    hydrationGenerationRef.current += 1;
    setHydrated(true);
    // Clear the persisted entry directly (submit success / explicit discard):
    // the persistence effect would also clear on the empty state, but this
    // runs synchronously so a submit-then-navigate can never leave the entry.
    if (userId && draftEntityKey) {
      void clearDraft(userId, draftEntityKey);
    }
  }, [userId, draftEntityKey]);

  const value = useMemo<PendingReviewContextValue>(
    () => ({ items, addComment, updateComment, removeComment, clear }),
    [items, addComment, updateComment, removeComment, clear]
  );

  return <PendingReviewContext value={value}>{children}</PendingReviewContext>;
}

/** Merges restored items after any user-added items, de-duplicated by id. */
function mergePendingReviewItems(
  previous: PendingReviewItem[],
  restored: PendingReviewItem[]
): PendingReviewItem[] {
  const existingIds = new Set(previous.map(item => item.id));
  const additions = restored.filter(item => !existingIds.has(item.id));
  return [...previous, ...additions];
}

export function usePendingReview(): PendingReviewContextValue {
  const context = useContext(PendingReviewContext);
  if (!context) {
    throw new Error('usePendingReview must be used within a PendingReviewProvider');
  }
  return context;
}
