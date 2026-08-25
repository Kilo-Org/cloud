import { useCallback, useEffect, useRef, useState } from 'react';
import { type TextInput } from 'react-native';

import { selectAwaitingCommit } from '@/components/agents/session-list-search-busy';
import {
  createDefaultSearchTimer,
  createSessionSearchController,
  resolveSearchRestoreDecision,
  type SessionSearchController,
} from '@/components/agents/session-search-state';
import type * as DraftsModule from '@/lib/persist/drafts';

// Durable draft persistence is loaded lazily via dynamic import so pure unit
// tests that import this hook never load encrypted-kv (expo-sqlite/drizzle).

let draftsPromise: Promise<typeof DraftsModule> | null = null;

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function getDrafts(): Promise<typeof DraftsModule> {
  draftsPromise ??= import('@/lib/persist/drafts');
  return draftsPromise;
}

/** TextInput remount key while the durable draft is still loading / empty. */
export const SESSION_SEARCH_DEFAULT_INPUT_KEY = 'session-search-empty';
/** TextInput remount key applied once to render a restored non-empty draft. */
export const SESSION_SEARCH_RESTORED_INPUT_KEY = 'session-search-restored';

export type UseSessionSearchInputParams = {
  /** Signed-in user id; persistence is skipped when empty. */
  userId: string | undefined;
  /** Durable draft value once loaded (null while not yet restored). */
  restoredQuery: string | null;
  /** True once the durable draft load has settled (identity or entity). */
  restoreSettled: boolean;
};

type UseSessionSearchInputResult = {
  /** Committed (debounced) search query that drives the list body. */
  searchQuery: string;
  /** Ref for the uncontrolled search TextInput. */
  searchInputRef: React.RefObject<TextInput | null>;
  /** Whether the search TextInput currently has non-empty text. */
  hasText: boolean;
  /** True while typed text is ahead of the committed (debounced) query. */
  awaitingCommit: boolean;
  /** TextInput remount key; changes once to render a restored draft. */
  searchInputKey: string;
  /** Initial content for the TextInput, set only on the restore remount. */
  searchDefaultValue: string | undefined;
  /** Call on every `onChangeText` from the search TextInput. */
  handleSearchInputChange: (text: string) => void;
  /** In-field X: imperatively clear the typed text, blur, and drop the query. */
  handleClearSearchInput: () => void;
  /** Imperatively clear the typed text and reset `hasText` (no blur). */
  clearSearchInput: () => void;
  /** Pure search controller for broader clear semantics (e.g. empty-state CTA). */
  searchController: SessionSearchController;
};

/**
 * Encapsulates the Agents search input's debounced commit, uncontrolled
 * TextInput ref, durable draft persistence, and the two clear paths
 * (search-only vs. broad). Keeps the screen focused on layout/query
 * consumption while preserving the exact 300ms debounce, dispose-on-unmount
 * behavior, and the restored-draft remount contract.
 */
export function useSessionSearchInput({
  userId,
  restoredQuery,
  restoreSettled,
}: UseSessionSearchInputParams): UseSessionSearchInputResult {
  const [searchQuery, setSearchQuery] = useState('');
  // Stale-closure guard: the ref is read by handleSearchInputChange so
  // selectAwaitingCommit always sees the latest committed query without
  // adding searchQuery as a useCallback dependency.
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;

  // Latest raw typed text lives in a ref — never triggers a render by
  // itself. Only the boolean awaitingCommit state drives the busy
  // indicator.
  const lastTypedRef = useRef('');

  // Boolean state whose setter returns its previous value while it stays
  // true, so extra keystrokes before the debounce commits are free of
  // SectionList re-renders.
  const [awaitingCommit, setAwaitingCommit] = useState(false);

  // Search debounce + clear semantics live in a pure controller so the
  // 300ms timing and the two clear paths (search-only vs. broad) can be
  // unit tested without react-native or real timers. The controller
  // holds its own pending-handle state — no setTimeout leaks into React.
  const searchControllerRef = useRef<SessionSearchController | null>(null);
  searchControllerRef.current ??= createSessionSearchController({
    timer: createDefaultSearchTimer(),
    commitSearchQuery: (query: string) => {
      setSearchQuery(query);
      // When the debounce commits, sync awaitingCommit so the busy
      // indicator disappears. Clear paths also hit this wrapper (they
      // call commitSearchQuery('') → setAwaitingCommit(false)).
      setAwaitingCommit(false);
    },
  });
  const searchController = searchControllerRef.current;

  // Restore remount state: starts empty; flips to a restore key exactly once
  // when a non-empty durable draft settles and the user has not typed.
  const [searchInputKey, setSearchInputKey] = useState(SESSION_SEARCH_DEFAULT_INPUT_KEY);
  const [searchDefaultValue, setSearchDefaultValue] = useState<string | undefined>(undefined);

  // Persist the visible typed string (durable, flushed). Skipped while the
  // account has not resolved (DEC-01 account scope).
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const saveSearchDraft = useCallback((text: string) => {
    const uid = userIdRef.current;
    if (!uid) {
      return;
    }
    void (async () => {
      const { saveDraft, flushDraft, SESSION_SEARCH_DRAFT_KEY } = await getDrafts();
      saveDraft(uid, SESSION_SEARCH_DRAFT_KEY, text);
      void flushDraft(uid, SESSION_SEARCH_DRAFT_KEY);
    })();
  }, []);

  const handleSearchChange = useCallback(
    (text: string) => {
      searchController.scheduleSearch(text);
    },
    [searchController]
  );

  // Search-only clear used by the in-field X: resets the debounced
  // query without touching the persisted platform/project narrowing
  // filters — the broad empty-state clear still owns that.
  const handleClearSearchOnly = useCallback(() => {
    searchController.clearSearchOnly();
    lastTypedRef.current = '';
    setAwaitingCommit(false);
    saveSearchDraft('');
  }, [searchController, saveSearchDraft]);

  // The search TextInput lives above the pinned "Active now" tray (so it's
  // always visible) but must stay uncontrolled — see iOS TextInput rules.
  const searchInputRef = useRef<TextInput>(null);
  const [hasText, setHasText] = useState(false);

  const handleSearchInputChange = useCallback(
    (text: string) => {
      const hasTextNow = text.length > 0;
      setHasText(hasTextNow);
      lastTypedRef.current = text;
      handleSearchChange(text);
      saveSearchDraft(text);

      // Only trigger a render when awaitingCommit transitions.
      // The functional updater returns prev when it already equals
      // shouldAwait so React skips the rerender. Both true→false
      // (backspace to match committed query before debounce fires)
      // and false→true (first typed char) are allowed transitions.
      const shouldAwait = selectAwaitingCommit({
        hasText: hasTextNow,
        lastTyped: text,
        searchQuery: searchQueryRef.current,
      });
      setAwaitingCommit(prev => (prev === shouldAwait ? prev : shouldAwait));
    },
    [handleSearchChange, saveSearchDraft]
  );

  // In-field X: imperatively clear what's visibly typed + dismiss the
  // keyboard, then drop the debounced query. Persisted filters are left
  // alone — the empty-state "Clear filters" CTA still owns the broad reset.
  const handleClearSearchInput = useCallback(() => {
    searchInputRef.current?.clear();
    searchInputRef.current?.blur();
    setHasText(false);
    handleClearSearchOnly();
  }, [handleClearSearchOnly]);

  // Broad clear primitive: reset the uncontrolled TextInput's visible text
  // and `hasText` flag without blurring. The caller still orchestrates the
  // query/filters reset via `searchController.clearBroadly`.
  const clearSearchInput = useCallback(() => {
    searchInputRef.current?.clear();
    setHasText(false);
    lastTypedRef.current = '';
    setAwaitingCommit(false);
    saveSearchDraft('');
  }, [saveSearchDraft]);

  // Seed the input once the durable draft settles and the user has not typed.
  // An empty persisted value (including '' persisted by a clear) seeds empty,
  // so a previously committed non-empty query is never reloaded. A non-empty
  // restored value also flips the remount key so the uncontrolled input shows
  // the restored text; the key never changes on later commits.
  useEffect(() => {
    const decision = resolveSearchRestoreDecision({
      settled: restoreSettled,
      hasTyped: lastTypedRef.current !== '',
      restoredQuery,
    });
    if (!decision.shouldSeed) {
      return;
    }
    lastTypedRef.current = decision.query;
    setHasText(decision.hasText);
    setSearchQuery(decision.query);
    if (decision.shouldRemount) {
      setSearchInputKey(SESSION_SEARCH_RESTORED_INPUT_KEY);
      setSearchDefaultValue(decision.query);
    }
  }, [restoreSettled, restoredQuery]);

  useEffect(
    () => () => {
      searchController.dispose();
    },
    [searchController]
  );

  return {
    searchQuery,
    searchInputRef,
    hasText,
    awaitingCommit,
    searchInputKey,
    searchDefaultValue,
    handleSearchInputChange,
    handleClearSearchInput,
    clearSearchInput,
    searchController,
  };
}
