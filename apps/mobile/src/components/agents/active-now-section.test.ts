import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

import { ACTIVE_NOW_TRAY_CAP, selectTrayWindow } from './active-now-window';

// Feature B (tray overflow) is a pure client-side presentation of already
// loaded rows. There is no fetch and therefore no retryable / non-retryable
// failure mode of its own — that rationale is recorded here per the
// feature-state matrix. Errors still come from the underlying active-session
// query and surface via the screen's existing inline "Couldn't refresh" line
// (unchanged by this slice).

// Feature B (tray overflow) is a pure client-side presentation of already
// loaded rows. There is no fetch and therefore no retryable / non-retryable
// failure mode of its own — that rationale is recorded here per the
// feature-state matrix. Errors still come from the underlying active-session
// query and surface via the screen's existing inline "Couldn't refresh" line
// (unchanged by this slice).

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

function pinned(): ActiveSession[] {
  return PINNED_IDS.map(id => makeActive({ id }));
}

describe('ACTIVE_NOW_TRAY_CAP', () => {
  it('is 3 (matches the design cap for the collapsed tray)', () => {
    // Regression guard — the cap is referenced from the section component,
    // the test, and the design doc; if it changes intentionally the design
    // doc must be updated too.
    expect(ACTIVE_NOW_TRAY_CAP).toBe(3);
  });
});

describe('selectTrayWindow — edge/empty (≤ cap)', () => {
  it('returns everything visible with hiddenCount 0 when at the cap', () => {
    const sessions = pinned().slice(0, 3);
    const result = selectTrayWindow(sessions, false, ACTIVE_NOW_TRAY_CAP);
    expect(result.visible).toEqual(sessions);
    expect(result.hiddenCount).toBe(0);
  });

  it('returns everything visible when below the cap, regardless of expanded', () => {
    const sessions = pinned().slice(0, 2);
    const collapsed = selectTrayWindow(sessions, false, ACTIVE_NOW_TRAY_CAP);
    const expanded = selectTrayWindow(sessions, true, ACTIVE_NOW_TRAY_CAP);
    expect(collapsed.visible).toEqual(sessions);
    expect(collapsed.hiddenCount).toBe(0);
    expect(expanded.visible).toEqual(sessions);
    expect(expanded.hiddenCount).toBe(0);
  });

  it('returns an empty window for an empty pinned set', () => {
    const result = selectTrayWindow([], false, ACTIVE_NOW_TRAY_CAP);
    expect(result.visible).toEqual([]);
    expect(result.hiddenCount).toBe(0);
  });

  it('expanded-then-shrunk to ≤ cap still returns all visible with no hidden', () => {
    // The "expanded but count drops to ≤ cap" case from the spec:
    // the section stops rendering any button; the state may stay `true`
    // harmlessly. The helper therefore must NOT clamp visible based on
    // `expanded` once the set fits under the cap.
    const shrunk = pinned().slice(0, 2);
    const result = selectTrayWindow(shrunk, true, ACTIVE_NOW_TRAY_CAP);
    expect(result.visible).toEqual(shrunk);
    expect(result.hiddenCount).toBe(0);
  });
});

describe('selectTrayWindow — happy (> cap, collapsed)', () => {
  it('shows the first cap rows in caller order when collapsed', () => {
    const sessions = pinned();
    const result = selectTrayWindow(sessions, false, ACTIVE_NOW_TRAY_CAP);
    expect(result.visible.map(s => s.id)).toEqual(['a', 'b', 'c']);
    // Caller order is preserved — the helper does not re-sort, it just slices.
  });

  it('reports the correct hiddenCount for the `+N more` label', () => {
    // 5 sessions total, cap 3 → 2 hidden
    const sessions = pinned();
    const result = selectTrayWindow(sessions, false, ACTIVE_NOW_TRAY_CAP);
    expect(result.hiddenCount).toBe(2);
  });

  it('uses the caller-supplied cap, not a hardcoded value', () => {
    // 5 sessions, cap 4 → 1 hidden
    const sessions = pinned();
    const result = selectTrayWindow(sessions, false, 4);
    expect(result.visible.map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.hiddenCount).toBe(1);
  });
});

describe('selectTrayWindow — happy (> cap, expanded)', () => {
  it('returns all rows with hiddenCount > 0 when expanded (drives `Show less`)', () => {
    // 5 sessions, cap 3 → 2 hidden → drives the `Show less` button
    const sessions = pinned();
    const result = selectTrayWindow(sessions, true, ACTIVE_NOW_TRAY_CAP);
    expect(result.visible).toEqual(sessions);
    expect(result.hiddenCount).toBe(2);
  });

  it('preserves caller order when expanded', () => {
    const shuffled = ['e', 'a', 'c', 'b', 'd'].map(id => makeActive({ id }));
    const result = selectTrayWindow(shuffled, true, ACTIVE_NOW_TRAY_CAP);
    expect(result.visible.map(s => s.id)).toEqual(['e', 'a', 'c', 'b', 'd']);
  });
});

describe('expander button presence/absence (driven by selectTrayWindow)', () => {
  // The ActiveNowSection renders the expander button iff `hiddenCount > 0`.
  // The cases below are the per-state matrix entries the section must
  // produce, derived directly from the helper's contract.

  it('renders NO expander when at the cap', () => {
    const result = selectTrayWindow(pinned().slice(0, 3), false, ACTIVE_NOW_TRAY_CAP);
    expect(result.hiddenCount > 0).toBe(false);
  });

  it('renders NO expander when below the cap, even if expanded state lingers', () => {
    const result = selectTrayWindow(pinned().slice(0, 1), true, ACTIVE_NOW_TRAY_CAP);
    expect(result.hiddenCount > 0).toBe(false);
  });

  it('renders the `+N more` button when collapsed above the cap', () => {
    const result = selectTrayWindow(pinned(), false, ACTIVE_NOW_TRAY_CAP);
    expect(result.hiddenCount > 0).toBe(true);
    expect(result.hiddenCount).toBe(2);
  });

  it('renders the `Show less` button when expanded above the cap', () => {
    const result = selectTrayWindow(pinned(), true, ACTIVE_NOW_TRAY_CAP);
    expect(result.hiddenCount > 0).toBe(true);
    expect(result.hiddenCount).toBe(2);
  });

  it('renders NO expander when expanded-then-shrunk to ≤ cap', () => {
    const result = selectTrayWindow(pinned().slice(0, 2), true, ACTIVE_NOW_TRAY_CAP);
    expect(result.hiddenCount > 0).toBe(false);
  });
});

// Smoke test for the reduced-motion path: the component must import and
// structurally reference the module under a `useReducedMotion() => true`
// mock without throwing, so the non-animated branch is reachable from
// tests. The deep assertion of behavior (no FadeIn/FadeOut applied) is
// covered on-device via the accessibility hierarchy; here we only verify
// the module is testable end-to-end with a mocked reanimated.
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react', async () => {
  const actual = (await vi.importActual('react')) as typeof React;
  return {
    ...actual,
    useState: vi.fn(<T>(initial: T) => [initial, () => undefined] as [T, () => void]),
  };
});
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
}));
vi.mock('@/components/agents/session-row', () => ({
  RemoteSessionRow: 'RemoteSessionRow',
}));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

describe('ActiveNowSection import smoke (reduced-motion path)', () => {
  it('loads the module under useReducedMotion() => true without throwing', async () => {
    // Importing lazily after the mock is registered. We only need the
    // module to be importable and the exported function to be defined.
    const mod = await import('./active-now-section');
    expect(typeof mod.ActiveNowSection).toBe('function');
  });

  it('suppresses LinearTransition on tray and expander under reduced motion', async () => {
    // The module is mocked with useReducedMotion() => true. The tray
    // container and expander wrapper must pass layout={undefined} so
    // no layout transition animates under reduced motion.
    const mod = await import('./active-now-section');
    const { ActiveNowSection } = mod;

    // Call the component as a function (not JSX) so we can inspect the
    // returned tree under the useState mock without a renderer.
    type SectionProps = {
      pinned: ActiveSession[];
      organizationIdBySessionId: Map<string, string>;
      onSessionPress: () => void;
    };
    const renderSection = ActiveNowSection as (props: SectionProps) => React.ReactElement;
    const element = renderSection({
      pinned: pinned(),
      organizationIdBySessionId: new Map(),
      onSessionPress: () => undefined,
    });

    // Collect every element that carries a `layout` prop key. Under
    // reduced motion every such layout must be undefined (the gate is
    // `layout={reducedMotion ? undefined : LinearTransition}`).
    const layoutElements = findElementsWithLayoutProp(element);
    expect(layoutElements.length).toBeGreaterThan(0);
    for (const view of layoutElements) {
      const props = view.props as { layout?: unknown };
      expect(props.layout).toBeUndefined();
    }
  });
});

type ElementProps = { layout?: unknown; children?: unknown };

function findElementsWithLayoutProp(node: unknown): React.ReactElement[] {
  const results: React.ReactElement[] = [];
  function visit(current: unknown) {
    if (
      current === null ||
      current === undefined ||
      typeof current === 'string' ||
      typeof current === 'number' ||
      typeof current === 'boolean'
    ) {
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child);
      }
      return;
    }
    if (React.isValidElement(current)) {
      const props = current.props as ElementProps;
      if (Object.hasOwn(props, 'layout')) {
        results.push(current);
      }
      visit(props.children);
    }
  }
  visit(node);
  return results;
}
