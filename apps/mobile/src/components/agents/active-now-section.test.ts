import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

// The section is pure presentation of rows the caller already loaded. It runs
// no query, so it has no retryable and no non-retryable state of its own.
// Active-session query errors surface in the screen's inline error line, which
// this section does not own.

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
}));
vi.mock('@/components/agents/remote-session-row', () => ({
  RemoteSessionRow: 'RemoteSessionRow',
}));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));

function makeActive(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

const PINNED_IDS = ['a', 'b', 'c', 'd', 'e'];

function pinnedSessions(): ActiveSession[] {
  return PINNED_IDS.map(id => makeActive({ id }));
}

type SectionProps = {
  pinned: ActiveSession[];
  organizationIdBySessionId: Map<string, string>;
  onSessionPress: () => void;
};

/**
 * Call the section as a plain function (not JSX) so the returned tree can be
 * inspected without a renderer. The module is imported lazily so the mocks
 * above are registered first. The component holds no state, so calling it
 * directly is safe.
 */
async function renderSection(sessions: ActiveSession[]) {
  const mod = await import('./active-now-section');
  const section = mod.ActiveNowSection as (props: SectionProps) => React.ReactElement | null;
  return section({
    pinned: sessions,
    organizationIdBySessionId: new Map(),
    onSessionPress: () => undefined,
  });
}

function elementProps(element: React.ReactElement): Record<string, unknown> {
  return element.props as Record<string, unknown>;
}

/** Every element in the returned tree, parents before children. */
function collectElements(node: unknown): React.ReactElement[] {
  const results: React.ReactElement[] = [];
  function visit(current: unknown) {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child);
      }
      return;
    }
    if (React.isValidElement(current)) {
      results.push(current);
      visit(elementProps(current).children);
    }
  }
  visit(node);
  return results;
}

describe('ActiveNowSection rows', () => {
  it('renders one row per pinned session, with no cap', async () => {
    // Rows are `AnimatedRow` elements; their own children are not evaluated
    // without a renderer, so the elements carrying a `session` prop are the
    // row count.
    const rows = collectElements(await renderSection(pinnedSessions())).filter(element =>
      Object.hasOwn(elementProps(element), 'session')
    );
    expect(rows).toHaveLength(PINNED_IDS.length);
  });

  it('renders no expander control', async () => {
    // The `+N more` / `Show less` expander was the only button in the section.
    const buttons = collectElements(await renderSection(pinnedSessions())).filter(
      element => elementProps(element).accessibilityRole === 'button'
    );
    expect(buttons).toEqual([]);
  });

  it('renders nothing when no session is pinned', async () => {
    expect(await renderSection([])).toBeNull();
  });
});

describe('ActiveNowSection reduced motion', () => {
  it('loads the module under useReducedMotion() => true without throwing', async () => {
    const mod = await import('./active-now-section');
    expect(typeof mod.ActiveNowSection).toBe('function');
  });

  it('suppresses LinearTransition on the tray under reduced motion', async () => {
    // The gate is `layout={reducedMotion ? undefined : LinearTransition}`, so
    // every element that carries a `layout` prop must pass `undefined`.
    const layoutElements = collectElements(await renderSection(pinnedSessions())).filter(element =>
      Object.hasOwn(elementProps(element), 'layout')
    );
    expect(layoutElements.length).toBeGreaterThan(0);
    for (const element of layoutElements) {
      expect(elementProps(element).layout).toBeUndefined();
    }
  });
});
