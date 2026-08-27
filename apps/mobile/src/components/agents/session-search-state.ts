// Pure (react/react-native-free) controller for the Agents-page search
// input's debounced commit + clear transitions. Extracted out of
// session-list-screen.tsx so the timing + reset semantics can be unit
// tested with an injectable timer and no react-native test renderer.

import {
  type AgentSessionFilters,
  clearAgentSessionNarrowingFilters,
} from '@/lib/agent-session-filters';

/** Debounce delay (ms) for trimming + committing the search query. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Minimal timer contract the search controller needs. Kept narrow so a
 * vitest fake can stand in without touching real setTimeout globals.
 */
export type SearchTimer = {
  set(callback: () => void, delayMs: number): { cancel(): void };
  clear(): void;
};

/** Real-browser-style timer, used by the screen's wiring. */
export function createDefaultSearchTimer(): SearchTimer {
  return {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      return {
        cancel: () => {
          clearTimeout(handle);
        },
      };
    },
    clear() {
      // Per-handle `cancel()` is the supported path; this stays for API
      // completeness and as a no-op when nothing is pending.
    },
  };
}

export type SessionSearchController = {
  /**
   * Schedule a debounced commit of the (trimmed) text, replacing any
   * pending one. Mirrors the prior in-screen behavior: a fast typist
   * never sees a stale commit land behind their latest keystroke.
   */
  scheduleSearch(text: string): void;
  /**
   * Search-only clear: cancel any pending debounce and commit an empty
   * query. Intentionally does NOT touch the persisted platform/project
   * narrowing filters — that is the in-field X's job, not the broad
   * "Clear filters" CTA's.
   */
  clearSearchOnly(): void;
  /**
   * Broad clear (empty-state "Clear search" / "Clear filters" CTAs):
   * cancel any pending debounce, commit an empty query, AND apply the
   * narrowing-filter reset via the provided `applyFilters` callback so
   * the screen can preserve the persisted sort preference.
   */
  clearBroadly(
    applyFilters: (transform: (prev: AgentSessionFilters) => AgentSessionFilters) => void
  ): void;
  /** Cancel any pending debounce without committing (used on unmount). */
  dispose(): void;
  /** Test-only: whether a debounce is currently pending. */
  hasPending(): boolean;
};

export function createSessionSearchController({
  timer,
  delayMs = SEARCH_DEBOUNCE_MS,
  commitSearchQuery,
}: {
  timer: SearchTimer;
  delayMs?: number;
  commitSearchQuery: (query: string) => void;
}): SessionSearchController {
  let pending: { cancel(): void } | null = null;

  function cancelPending(): void {
    if (pending) {
      pending.cancel();
      pending = null;
    }
  }

  return {
    scheduleSearch(text) {
      cancelPending();
      pending = timer.set(() => {
        pending = null;
        commitSearchQuery(text.trim());
      }, delayMs);
    },
    clearSearchOnly() {
      cancelPending();
      commitSearchQuery('');
    },
    clearBroadly(applyFilters) {
      cancelPending();
      commitSearchQuery('');
      applyFilters(prev => clearAgentSessionNarrowingFilters(prev));
    },
    dispose: cancelPending,
    hasPending: () => pending !== null,
  };
}

/** The seed applied when a durable search draft finishes restoring. */
export type SearchRestoreDecision = {
  /** True when the input should be seeded from the restored value. */
  shouldSeed: boolean;
  /** The query to seed (empty string when nothing was stored). */
  query: string;
  /** Whether the seeded text is non-empty (in-field X + list filter). */
  hasText: boolean;
  /** True when the uncontrolled input must remount to show the seeded text. */
  shouldRemount: boolean;
};

/**
 * Decides whether a restored search draft should seed the input. Seeds only
 * after the load settles AND only when the user has not typed yet. A settled
 * empty value (including the empty string persisted by a clear) seeds an empty
 * query, so a previously committed non-empty query is never reloaded.
 */
export function resolveSearchRestoreDecision(input: {
  settled: boolean;
  hasTyped: boolean;
  restoredQuery: string | null;
}): SearchRestoreDecision {
  if (!input.settled || input.hasTyped) {
    return { shouldSeed: false, query: '', hasText: false, shouldRemount: false };
  }
  const query = input.restoredQuery ?? '';
  return {
    shouldSeed: true,
    query,
    hasText: query.length > 0,
    shouldRemount: query.length > 0,
  };
}
