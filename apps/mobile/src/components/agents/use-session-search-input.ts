import { useCallback, useEffect, useRef, useState } from 'react';
import { type TextInput } from 'react-native';

import {
  createDefaultSearchTimer,
  createSessionSearchController,
  type SessionSearchController,
} from '@/components/agents/session-search-state';

type UseSessionSearchInputResult = {
  /** Committed (debounced) search query that drives the list body. */
  searchQuery: string;
  /** Ref for the uncontrolled search TextInput. */
  searchInputRef: React.RefObject<TextInput | null>;
  /** Whether the search TextInput currently has non-empty text. */
  hasText: boolean;
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
 * TextInput ref, and the two clear paths (search-only vs. broad). Keeps the
 * screen focused on layout/query consumption while preserving the exact 300ms
 * debounce and dispose-on-unmount behavior.
 */
export function useSessionSearchInput(): UseSessionSearchInputResult {
  const [searchQuery, setSearchQuery] = useState('');

  // Search debounce + clear semantics live in a pure controller so the
  // 300ms timing and the two clear paths (search-only vs. broad) can be
  // unit tested without react-native or real timers. The controller
  // holds its own pending-handle state — no setTimeout leaks into React.
  const searchControllerRef = useRef<SessionSearchController | null>(null);
  searchControllerRef.current ??= createSessionSearchController({
    timer: createDefaultSearchTimer(),
    commitSearchQuery: setSearchQuery,
  });
  const searchController = searchControllerRef.current;

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
  }, [searchController]);

  // The search TextInput lives above the pinned "Active now" tray (so it's
  // always visible) but must stay uncontrolled — see iOS TextInput rules.
  const searchInputRef = useRef<TextInput>(null);
  const [hasText, setHasText] = useState(false);

  const handleSearchInputChange = useCallback(
    (text: string) => {
      setHasText(text.length > 0);
      handleSearchChange(text);
    },
    [handleSearchChange]
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
  }, []);

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
    handleSearchInputChange,
    handleClearSearchInput,
    clearSearchInput,
    searchController,
  };
}
