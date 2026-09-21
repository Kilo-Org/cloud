import { createElement, type ElementType } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseQueryOptions } from '@tanstack/react-query';
import type * as ReactI18next from 'react-i18next';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { TourRemoteStep } from './tour-remote-step';
import { TourStepHeader } from './tour-step-header';

type Renderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

// The single `listInstances` query the step owns.
const fetchInstances = vi.hoisted(() =>
  vi.fn<() => Promise<{ instances: InstancePickerInstance[] }>>()
);
const QUERY_KEY = ['tour-remote-instances'];

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      listInstances: {
        queryOptions: (_input: undefined, options: Partial<UseQueryOptions>) => ({
          queryKey: QUERY_KEY,
          queryFn: fetchInstances,
          ...options,
          retryDelay: 0,
        }),
      },
    },
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#666666',
    primary: '#0000ff',
    good: '#24784A',
  }),
}));
// Load-bearing, not leftover: the error branch renders `QueryError`, whose
// `EmptyState` imports `@/components/centered-state`. That real module pulls
// `expo`/`@sentry/react-native` through the native surface-geometry hook, and
// those externalized packages load the real `react-native` index, which the
// node-env harness cannot parse. The step itself never renders `CenteredState`
// — it centres the body with the scroll container's own classes — so the
// zero-count assertion below stays honest.
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  ChevronRight: 'ChevronRight',
  Lock: 'Lock',
  SearchX: 'SearchX',
  Server: 'Server',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));

const REMOTE: InstancePickerInstance = {
  connectionId: 'conn-1',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'remote',
  startedAt: null,
  gitBranch: null,
};

const REMOTE2: InstancePickerInstance = { ...REMOTE, connectionId: 'conn-2', name: 'desktop' };

function childValues(node: { children?: unknown }): unknown[] {
  return Array.isArray(node.children) ? node.children : [node.children];
}

function hasTextIn(node: ReactTestInstance, value: string): boolean {
  return node
    .findAllByType('Text' as ElementType)
    .some(entry => childValues(entry.props).includes(value));
}

function hasText(renderer: Renderer, value: string): boolean {
  return hasTextIn(renderer.root, value);
}

/**
 * The one reserved content slot. State swaps (skeleton -> list -> error ->
 * empty) happen inside it, so the header above it must never be its child.
 */
function reservedSlot(renderer: Renderer) {
  const slot = renderer.root.findAllByType('View' as ElementType).find(node => {
    const { className } = node.props as { className?: string };
    return typeof className === 'string' && className.includes('min-h-[240px]');
  });
  if (!slot) {
    throw new Error('reserved content slot not found');
  }
  return slot;
}

/**
 * The reserved slot, with the header proven to sit above it rather than inside
 * it — regardless of which branch renders, so a state swap cannot move the
 * header.
 */
function layoutSlot(renderer: Renderer) {
  const slot = reservedSlot(renderer);
  expect(renderer.root.findAllByType(TourStepHeader)).toHaveLength(1);
  expect(slot.findAllByType(TourStepHeader)).toHaveLength(0);
  return slot;
}

function press(node: { props: unknown }) {
  (node.props as { onPress?: () => void }).onPress?.();
}

/** The row at `index`, or a loud failure so a missing row never reads as a pass. */
function requireRow(rows: ReactTestInstance[], index: number): ReactTestInstance {
  const row = rows[index];
  if (!row) {
    throw new Error(`row not found: ${index}`);
  }
  return row;
}

async function mountStep() {
  const onChooseComputer = vi.fn<(connectionId: string) => void>();
  const mounted = await renderWithProviders(createElement(TourRemoteStep, { onChooseComputer }));
  return { ...mounted, onChooseComputer };
}

describe('TourRemoteStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchInstances.mockReset().mockResolvedValue({ instances: [] });
  });

  it('reserves one content slot below the header that every branch renders into', async () => {
    const { renderer, unmount } = await mountStep();

    // The header sits above the slot, never inside it: a state swap inside the
    // slot cannot move the illustration and heading.
    layoutSlot(renderer);

    unmount();
  });

  it('carries the tour eyebrow in the step header, above the reserved slot', async () => {
    const { renderer, unmount } = await mountStep();

    const header = renderer.root.findByType(TourStepHeader);
    expect(header.props.eyebrow).toBe('tour.eyebrow');
    // The header sits above the slot, so a loading -> list -> error swap inside
    // the slot can never move the label.
    const slot = layoutSlot(renderer);
    expect(hasTextIn(slot, 'tour.eyebrow')).toBe(false);
    expect(hasText(renderer, 'tour.eyebrow')).toBe(true);

    unmount();
  });

  it('centres the step body in the band between the header and the action bar', async () => {
    fetchInstances.mockResolvedValue({ instances: [] });
    const { renderer, unmount } = await mountStep();

    // One ScrollView owns the whole step body. Its content container grows to
    // the viewport (`grow`) and distributes the header and the reserved slot in
    // the middle (`justify-center`), so the block sits in the space between the
    // header and the Skip bar instead of against the header. `grow` is a
    // minimum, so taller content still scrolls rather than being clipped.
    const scroller = renderer.root.findByType('ScrollView' as ElementType);
    expect(scroller.props.contentContainerClassName).toBe(
      'grow items-center justify-center gap-6 px-6 py-6'
    );
    expect(renderer.root.findAllByType('CenteredState' as ElementType)).toHaveLength(0);

    unmount();
  });

  it('renders content-shaped skeleton rows while the computer list is loading', async () => {
    fetchInstances.mockReturnValue(new Promise(() => undefined));
    const { renderer, unmount } = await mountStep();

    const slot = layoutSlot(renderer);
    expect(slot.findAllByType('Skeleton' as ElementType).length).toBeGreaterThan(0);
    expect(slot.findAllByType('Pressable' as ElementType)).toHaveLength(0);
    expect(hasText(renderer, 'tour.remoteEmptyTitle')).toBe(false);
    expect(hasText(renderer, 'tour.checkAgain')).toBe(false);
    expect(hasText(renderer, 'tour.remoteFound')).toBe(false);

    unmount();
  });

  it('shows the empty copy, the start instructions and a working Check again', async () => {
    fetchInstances.mockResolvedValue({ instances: [] });
    const { renderer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteEmptyTitle'));
    const slot = layoutSlot(renderer);
    expect(hasTextIn(slot, 'tour.remoteEmptyTitle')).toBe(true);
    expect(hasTextIn(slot, 'tour.remoteEmptyBody')).toBe(true);
    expect(hasTextIn(slot, 'tour.remoteRunHint')).toBe(true);
    expect(hasTextIn(slot, 'tour.checkAgain')).toBe(true);

    const before = fetchInstances.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    await waitFor(() => fetchInstances.mock.calls.length > before);

    unmount();
  });

  it('shows a working retry for a retryable list failure without losing the step chrome', async () => {
    fetchInstances.mockRejectedValue(new Error('offline'));
    const { renderer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.networkError'));
    expect(hasText(renderer, 'tour.remoteTitle')).toBe(true);
    expect(hasText(renderer, 'tour.remoteBody')).toBe(true);
    const slot = layoutSlot(renderer);
    expect(hasTextIn(slot, 'tour.networkError')).toBe(true);
    expect(slot.findAllByType('Pressable' as ElementType)).toHaveLength(0);

    const before = fetchInstances.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    await waitFor(() => fetchInstances.mock.calls.length > before);

    unmount();
  });

  it('keeps the detected computers and shows a compact inline retry when a background refresh fails', async () => {
    // First load succeeds so the rows are on screen; every later poll fails,
    // exactly as a 10s refetch does when the network drops mid-tour.
    fetchInstances
      .mockResolvedValueOnce({ instances: [REMOTE] })
      .mockRejectedValue(new Error('offline'));
    const { renderer, queryClient, onChooseComputer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteFound'));
    expect(layoutSlot(renderer).findAllByType('Pressable' as ElementType)).toHaveLength(1);

    // Force the failing background refetch to settle while the rows are visible.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: QUERY_KEY });
    });
    // TanStack Query batches observer notifications onto a macrotask, so the
    // failing state reaches the tree one turn later: yield it inside `act`
    // before reading the tree back.
    await waitFor(() => hasTextIn(layoutSlot(renderer), 'agents.sessionList.couldNotRefresh'));

    // The failure must not blank the list: the detected computer stays
    // tappable and the failure surfaces as a compact inline status with Retry,
    // never the full-slot network-error screen.
    const slot = layoutSlot(renderer);
    expect(hasTextIn(slot, 'tour.remoteFound')).toBe(true);
    expect(hasTextIn(slot, 'tour.networkError')).toBe(false);

    const pressables = slot.findAllByType('Pressable' as ElementType);
    const row = pressables.find(node => node.props.accessibilityLabel === 'laptop');
    if (!row) {
      throw new Error('detected computer row not found');
    }
    // The person can still act on the detected computer mid-failure.
    act(() => {
      press(row);
    });
    expect(onChooseComputer).toHaveBeenCalledWith('conn-1');

    const retry = pressables.find(node => node.props.accessibilityLabel === 'common.retry');
    if (!retry) {
      throw new Error('inline retry not found');
    }
    expect(hasTextIn(slot, 'agents.sessionList.couldNotRefresh')).toBe(true);

    const before = fetchInstances.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
      press(retry);
    });
    await waitFor(() => fetchInstances.mock.calls.length > before);

    unmount();
  });

  it('lists one labelled hand-off row and the start instructions per detected computer', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE, REMOTE2] });
    const { renderer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteFound'));
    const slot = layoutSlot(renderer);
    const rows = slot.findAllByType('Pressable' as ElementType);
    expect(rows.map(row => row.props)).toMatchObject([
      { accessibilityRole: 'button', accessibilityLabel: 'laptop' },
      { accessibilityRole: 'button', accessibilityLabel: 'desktop' },
    ]);
    // The `kilo remote` / `/remote` start instructions stay visible next to the
    // detected list.
    expect(hasTextIn(slot, 'tour.remoteRunHint')).toBe(true);
    expect(slot.findAllByType('Server' as ElementType)).toHaveLength(2);
    expect(slot.findAllByType('ChevronRight' as ElementType)).toHaveLength(2);

    unmount();
  });

  it('hands off the tapped computer connection id', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE, REMOTE2] });
    const { renderer, onChooseComputer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteFound'));
    const rows = layoutSlot(renderer).findAllByType('Pressable' as ElementType);

    act(() => {
      press(requireRow(rows, 0));
    });
    expect(onChooseComputer).toHaveBeenCalledTimes(1);
    expect(onChooseComputer).toHaveBeenCalledWith('conn-1');

    act(() => {
      press(requireRow(rows, 1));
    });
    expect(onChooseComputer).toHaveBeenCalledTimes(2);
    expect(onChooseComputer).toHaveBeenLastCalledWith('conn-2');

    unmount();
  });
});
