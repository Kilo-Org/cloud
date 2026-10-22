import { useCallback, useEffect, useRef, useState } from 'react';
import { type TextInput } from 'react-native';

import { selectAwaitingCommit } from '@/components/agents/session-list-search-busy';
import {
  createDefaultSearchTimer,
  createSessionSearchController,
  resolveSearchRestoreDecision,
  type SessionSearchController,
} from '@/components/agents/session-search-state';
import { saveDraft, SESSION_SEARCH_DRAFT_KEY } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';

/**
 * TextInput remount key prefix. The visible text of this field changes only
 * through a remount: the field is uncontrolled, so a value written by native
 * code (a restored draft's `defaultValue`) is invisible to the JS TextInput's
 * event count, and the imperative `clear()` command that count gates is then
 * dropped on Android. Every replacement of the visible text therefore bumps the
 * epoch and mounts a fresh input with that text as its `defaultValue`.
 */
const SESSION_SEARCH_INPUT_KEY_PREFIX = 'session-search-input';

export type UseSessionSearchInputParams = {
  /** Signed-in user id; persistence is skipped when empty. */
  userId: string | undefined;
  /** Durable draft value once loaded (null while not yet restored). */
  restoredQuery: string | null;
  /** True once the durable draft load has settled (identity or entity). */
  restoreSettled: boolean;
};

export type UseSessionSearchInputResult = {
  /** Committed (debounced) search query that drives the list body. */
  searchQuery: string;
  /** Ref for the uncontrolled search TextInput. */
  searchInputRef: React.RefObject<TextInput | null>;
  /** Whether the search TextInput currently has non-empty text. */
  hasText: boolean;
  /** True while typed text is ahead of the committed (debounced) query. */
  awaitingCommit: boolean;
  /** TextInput remount key; a new value mounts the input with `searchDefaultValue`. */
  searchInputKey: string;
  /** Content the next remounted TextInput shows; '' after a clear. */
  searchDefaultValue: string | undefined;
  /** Call on every `onChangeText` from the search TextInput. */
  handleSearchInputChange: (text: string) => void;
  /** In-field X: empty the visible text through a remount, blur, drop the query. */
  handleClearSearchInput: () => void;
  /** Empty the visible text through a remount and reset `hasText` (no blur). */
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

  // Whether the user has touched this field in this mount (typed or cleared).
  // Separate from `lastTypedRef`, whose emptiness also means "the user cleared
  // it": a late draft settle must not seed a field the user has already
  // emptied, and it must not undo a clear.
  const userInteractedRef = useRef(false);

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

  // Visible-text state. The field is uncontrolled, so the only way to replace
  // its text is a remount: `inputEpoch` makes every replacement a new mount,
  // and `searchDefaultValue` is what that mount shows. Typing never touches
  // these, so a keystroke never remounts the field.
  const [inputEpoch, setInputEpoch] = useState(0);
  const [searchDefaultValue, setSearchDefaultValue] = useState<string | undefined>(undefined);
  const replaceInputText = useCallback((text: string) => {
    setSearchDefaultValue(text);
    setInputEpoch(epoch => epoch + 1);
  }, []);
  const searchInputKey = `${SESSION_SEARCH_INPUT_KEY_PREFIX}-${inputEpoch}`;

  // Persist the visible typed string through the 500 ms durable draft
  // debounce — the per-key pending timer is left to commit on its own so
  // typing never forces an encrypted write per keystroke. Skipped while the
  // account has not resolved (DEC-01 account scope).
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // The debounced write still has to survive a background/kill inside the
  // window, so flush the pending search draft when the app leaves `active`
  // and on unmount.
  useDraftFlushOnBackground(userId, SESSION_SEARCH_DRAFT_KEY, true);

  const saveSearchDraft = useCallback((text: string) => {
    const uid = userIdRef.current;
    if (!uid) {
      return;
    }
    saveDraft(uid, SESSION_SEARCH_DRAFT_KEY, text);
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
    userInteractedRef.current = true;
    searchController.clearSearchOnly();
    lastTypedRef.current = '';
    setAwaitingCommit(false);
    saveSearchDraft('');
  }, [searchController, saveSearchDraft]);

  // The search TextInput lives above the pinned "Active now" tray (so it's
  // always visible) but must stay uncontrolled — see iOS TextInput rules.
  const searchInputRef = useRef<TextInput>(null);

  const refocusAfterRemountRef = useRef(false);
  const [hasText, setHasText] = useState(false);

  const handleSearchInputChange = useCallback(
    (text: string) => {
      const hasTextNow = text.length > 0;
      userInteractedRef.current = true;
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

  // In-field X: empty the visible text through a remount, dismiss the
  // keyboard, then drop the debounced query. The remount is what makes the
  // field empty: the dropped native `clear()` left a restored draft's text on
  // screen while the state already said "no text". Persisted filters are left
  // alone — the empty-state "Clear filters" CTA still owns the broad reset.
  const handleClearSearchInput = useCallback(() => {
    searchInputRef.current?.blur();
    replaceInputText('');
    setHasText(false);
    handleClearSearchOnly();
  }, [handleClearSearchOnly, replaceInputText]);

  // Broad clear primitive: empty the visible text through a remount and reset
  // `hasText` without blurring. If the field owned focus before the remount,
  // return it to the new input after React attaches the ref.
  const clearSearchInput = useCallback(() => {
    userInteractedRef.current = true;
    refocusAfterRemountRef.current = searchInputRef.current?.isFocused() ?? false;
    replaceInputText('');
    setHasText(false);
    lastTypedRef.current = '';
    setAwaitingCommit(false);
    saveSearchDraft('');
  }, [replaceInputText, saveSearchDraft]);

  useEffect(() => {
    if (!refocusAfterRemountRef.current) {
      return;
    }
    refocusAfterRemountRef.current = false;
    searchInputRef.current?.focus();
  }, [searchInputKey]);

  // Seed the input once the durable draft settles and the user has not touched
  // it. An empty persisted value (including '' persisted by a clear) seeds
  // empty, so a previously committed non-empty query is never reloaded, and a
  // settle that lands after a clear is ignored rather than restoring the text
  // the user just removed. A non-empty restored value remounts the uncontrolled
  // input so it shows the restored text.
  useEffect(() => {
    const decision = resolveSearchRestoreDecision({
      settled: restoreSettled,
      hasInteracted: userInteractedRef.current,
      restoredQuery,
    });
    if (!decision.shouldSeed) {
      return;
    }
    lastTypedRef.current = decision.query;
    setHasText(decision.hasText);
    setSearchQuery(decision.query);
    if (decision.shouldRemount) {
      replaceInputText(decision.query);
    }
  }, [restoreSettled, restoredQuery, replaceInputText]);

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
