import * as Sentry from '@sentry/react-native';
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
import { z } from 'zod';
import { clearDraft, loadDraft, prReviewDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';

// One queued inline comment in the pending review. The composer fills
// this in when the user taps "Add to review"; the submit sheet submits
// only the fresh items in one `submitReview` batch call.
//
// `commitSha` records the PR head SHA at the time the comment was
// queued so the submit sheet can flag it "outdated" if the head moves
// between queue and submit. Stale items are never sent: the submit
// sheet partitions the queue and submits only the fresh items, leaving
// stale items queued for the user to edit or delete.
const PendingReviewItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  side: z.union([z.literal('LEFT'), z.literal('RIGHT')]),
  line: z.number(),
  startLine: z.number().optional(),
  body: z.string(),
  commitSha: z.string(),
});

export type PendingReviewItem = z.infer<typeof PendingReviewItemSchema>;

function isPendingReviewItem(value: unknown): value is PendingReviewItem {
  return PendingReviewItemSchema.safeParse(value).success;
}

/**
 * Runtime shape guard for a persisted pending-review draft. Passed to
 * `loadDraft` so a valid-JSON value that is not an array is discarded as
 * corrupt. Item shapes are deliberately NOT checked here: one unrecognized
 * item must cost one comment, not the whole queue, so the items are filtered
 * after the load by `keepValidPendingReviewItems`.
 */
export function isPendingReviewDraft(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Keeps the structurally valid restored items and drops only the invalid ones,
 * so a single corrupt row never destroys the queued review. A drop is reported
 * to Sentry at warning level (the same treatment a discarded draft gets: no
 * user action re-reads a draft, so there is nothing to retry).
 */
function keepValidPendingReviewItems(restored: unknown[]): PendingReviewItem[] {
  const valid = restored.filter((item): item is PendingReviewItem => isPendingReviewItem(item));
  if (valid.length !== restored.length) {
    Sentry.captureException(new Error('stored pending review dropped invalid items'), {
      level: 'warning',
      extra: { dropped: restored.length - valid.length, kept: valid.length },
    });
  }
  return valid;
}

/**
 * Draft entity key for one pull request, with both path segments lowercased —
 * the same normalization `recent-prs.ts` and `viewed-files.ts` apply to their
 * `owner/repo#number` keys. Reaching one PR through `Kilo-Org/cloud` and
 * through `kilo-org/cloud` therefore uses ONE queue, not two.
 */
export function pendingReviewDraftKey(owner: string, repo: string, number: number): string {
  return prReviewDraftKey(owner.toLowerCase(), repo.toLowerCase(), number);
}

type PendingReviewContextValue = {
  items: PendingReviewItem[];
  addComment: (item: PendingReviewItem) => void;
  updateComment: (id: string, body: string) => void;
  removeComment: (id: string) => void;
  removeComments: (ids: readonly string[]) => void;
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
  // it, so a stale load never applies. `removeComments()` (submit) and
  // `clear()` (discard) bump the generation too, so a late hydration can never
  // merge old stored comments back into the queue after a successful submit or
  // discard (refs dodge the flow narrowing that
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
        const restored = await loadDraft(userId, draftEntityKey, isPendingReviewDraft);
        if (hydrationGenerationRef.current !== generation) {
          return;
        }
        const valid = restored === null ? [] : keepValidPendingReviewItems(restored);
        if (valid.length > 0) {
          setItems(previous => mergePendingReviewItems(previous, valid));
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
  // and the submit-success `removeComments`-to-empty durable.
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
  useDraftFlushOnBackground(userId, draftEntityKey, true);

  const addComment = useCallback((item: PendingReviewItem) => {
    setItems(previous => [...previous, item]);
  }, []);

  const updateComment = useCallback((id: string, body: string) => {
    setItems(previous => previous.map(item => (item.id === id ? { ...item, body } : item)));
  }, []);

  const removeComment = useCallback((id: string) => {
    setItems(previous => previous.filter(item => item.id !== id));
  }, []);

  const removeComments = useCallback((ids: readonly string[]) => {
    // An empty id list is a true no-op. APPROVE with no fresh comments
    // calls this before hydration; bumping the generation or marking
    // hydrated would discard the in-flight load and let the empty-state
    // persistence effect clear the stored draft.
    if (ids.length === 0) {
      return;
    }
    const idSet = new Set(ids);
    setItems(previous => previous.filter(item => !idSet.has(item.id)));
    // Same guard `clear()` carries: invalidate any in-flight hydration so a
    // late load cannot merge the just-posted comments back into the queue
    // after a successful submit. Mark hydration settled too, so the remaining
    // items persist even when the invalidated load never resolves. The
    // persistence effect writes the remainder (an empty remainder clears the
    // stored entry through its empty-state branch), so no direct clearDraft.
    hydrationGenerationRef.current += 1;
    setHydrated(true);
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    // A successful clear invalidates any in-flight hydration: a late load
    // must not merge the old stored comments back into the queue after the
    // user discarded the queue. Mark hydration settled too, so a later
    // addComment persists even when the invalidated load never resolves.
    hydrationGenerationRef.current += 1;
    setHydrated(true);
    // Clear the persisted entry directly (explicit discard): the persistence
    // effect would also clear on the empty state, but this runs synchronously
    // so a discard-then-navigate can never leave the entry.
    if (userId && draftEntityKey) {
      void clearDraft(userId, draftEntityKey);
    }
  }, [userId, draftEntityKey]);

  const value = useMemo<PendingReviewContextValue>(
    () => ({ items, addComment, updateComment, removeComment, removeComments, clear }),
    [items, addComment, updateComment, removeComment, removeComments, clear]
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
