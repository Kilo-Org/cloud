import { describe, expect, it } from 'vitest';

import {
  createSessionSearchController,
  SEARCH_DEBOUNCE_MS,
  type SearchTimer,
  type SessionSearchController,
} from '@/components/agents/session-search-state';
import { createDefaultAgentSessionFilters } from '@/lib/agent-session-filters';

type FakeTimer = SearchTimer & {
  fire(): void;
  hasActive(): boolean;
  lastDelay(): number;
};

/**
 * Single-pending fake timer: mirrors the controller's "one outstanding
 * debounce at a time" semantics. Each `set` returns a handle whose
 * `cancel()` is independent, and `fire()` runs the current callback
 * only if it has not been cancelled.
 */
function createFakeTimer(): FakeTimer {
  let current: { id: number; callback: () => void; delay: number } | null = null;
  const cancelled = new Set<number>();
  let nextId = 0;
  return {
    set(callback, delay) {
      nextId += 1;
      const id = nextId;
      current = { id, callback, delay };
      return {
        cancel() {
          cancelled.add(id);
        },
      };
    },
    clear() {
      if (current) {
        cancelled.add(current.id);
        current = null;
      }
    },
    fire() {
      if (current && !cancelled.has(current.id)) {
        const snapshot = current;
        current = null;
        snapshot.callback();
      } else if (current) {
        current = null;
      }
    },
    hasActive: () => current !== null && !cancelled.has(current.id),
    lastDelay: () => current?.delay ?? -1,
  };
}

function createController(timer: FakeTimer, commits: string[]): SessionSearchController {
  return createSessionSearchController({
    timer,
    commitSearchQuery: query => {
      commits.push(query);
    },
  });
}

describe('createSessionSearchController', () => {
  it('schedules a debounced commit of the trimmed text and fires it after the configured delay', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    controller.scheduleSearch('  hello world  ');

    // No commit yet — the debounce is still pending.
    expect(commits).toEqual([]);
    expect(controller.hasPending()).toBe(true);
    // The configured delay is forwarded to the timer verbatim so the
    // existing 300ms UX is preserved by the pure module.
    expect(timer.lastDelay()).toBe(SEARCH_DEBOUNCE_MS);

    timer.fire();
    expect(commits).toEqual(['hello world']);
    expect(controller.hasPending()).toBe(false);
  });

  it('replaces a pending debounce when a new keystroke arrives so only the latest text is committed', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    controller.scheduleSearch('first');
    controller.scheduleSearch('second');
    expect(timer.hasActive()).toBe(true);

    timer.fire();
    expect(commits).toEqual(['second']);
  });

  it('clearSearchOnly cancels the pending debounce, commits an empty query, and never commits the cancelled text', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    controller.scheduleSearch('in progress');
    expect(controller.hasPending()).toBe(true);

    controller.clearSearchOnly();
    expect(commits).toEqual(['']);
    expect(controller.hasPending()).toBe(false);

    // A late fire from the (already cancelled) timer must NOT land a
    // stale commit — that's the whole point of cancelling.
    timer.fire();
    expect(commits).toEqual(['']);
  });

  it('clearBroadly commits an empty query AND applies the narrowing-filter reset (preserving sort)', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    controller.scheduleSearch('still pending');
    const before = createDefaultAgentSessionFilters();
    const current = {
      ...before,
      platformFilter: ['macos'],
      projectFilter: ['git/a'],
      sortBy: 'updated_at' as const,
    };

    let receivedPrev: typeof current | null = null;
    controller.clearBroadly(apply => {
      receivedPrev = current;
      const next = apply(current);
      // sortBy stays — it's a persistent preference, not a filter.
      expect(next).toEqual({
        platformFilter: [],
        projectFilter: [],
        sortBy: 'updated_at',
      });
    });

    expect(receivedPrev).toBe(current);
    expect(commits).toEqual(['']);
    expect(controller.hasPending()).toBe(false);
  });

  it('clearBroadly is safe to call when no debounce is pending and still runs the filter transform', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    let applyCalls = 0;
    controller.clearBroadly(apply => {
      applyCalls += 1;
      // The transform is what actually clears the narrowing filters;
      // the test just proves the controller hands the previous value
      // through unchanged.
      const prev = createDefaultAgentSessionFilters();
      expect(apply(prev)).toEqual(prev);
    });
    expect(commits).toEqual(['']);
    expect(applyCalls).toBe(1);
  });

  it('dispose cancels a pending debounce without committing', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    controller.scheduleSearch('unsent');
    controller.dispose();
    expect(controller.hasPending()).toBe(false);

    timer.fire();
    expect(commits).toEqual([]);
  });

  it('clearSearchOnly followed by a new scheduleSearch commits the new text, not an empty string', () => {
    const timer = createFakeTimer();
    const commits: string[] = [];
    const controller = createController(timer, commits);

    controller.scheduleSearch('alpha');
    controller.clearSearchOnly();
    controller.scheduleSearch('beta');
    timer.fire();
    expect(commits).toEqual(['', 'beta']);
  });
});
