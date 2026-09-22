/* eslint-disable max-lines -- the four history paths and recovery controls share one native list harness; test-renderer mounts it without a DOM. */
import { createElement, type ReactElement, type ReactNode, type Ref } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { AgentSessionListContent } from './session-list-content';
import { RowsRefreshControl } from './rows-refresh-control';
import { type SessionListRow } from './session-list-rows';
import { type StoredSessionRow } from './session-row';
import { PULL_FEEDBACK_BUDGET_MS } from './use-pull-refresh';

type RowProps = Parameters<typeof StoredSessionRow>[0];
type CellProps = {
  item: SessionListRow;
  index: number;
  renderItem: (info: { item: SessionListRow; index: number; target: 'Cell' }) => ReactElement;
};
type ListProps = {
  data: readonly SessionListRow[];
  renderItem: CellProps['renderItem'];
  ListFooterComponent: ReactNode;
  ref?: Ref<{
    scrollToOffset: () => void;
    scrollToTop: () => void;
    getScrollResponder: () => { scrollTo: () => void };
  }>;
  extraData: number;
  onEndReached: () => void;
};
const controls = vi.hoisted(() => ({
  scrollResets: 0,
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  leftInset: 0,
  rightInset: 0,
}));
// Mutable so a case can put the tree on Android: the platform decides whether
// the floating pull-to-refresh indicator is safe (device defect uxs1) or the
// reserved band carries the in-flight state instead.
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@shopify/flash-list', async () => {
  const React = await import('react');
  // Virtualized cells reuse their renderer until its identity changes. This
  // catches a stale live-set closure even when the list itself re-renders.
  const Cell = React.memo(function SessionCell({ item, index, renderItem }: CellProps) {
    return renderItem({ item, index, target: 'Cell' });
  });
  return {
    FlashList: ({ data, renderItem, ListFooterComponent, ref, ...props }: ListProps) => {
      React.useImperativeHandle(
        ref,
        () => ({
          scrollToOffset: () => {
            controls.scrollResets += 1;
          },
          scrollToTop: () => {
            controls.scrollResets += 1;
          },
          getScrollResponder: () => ({
            scrollTo: () => {
              controls.scrollResets += 1;
            },
          }),
        }),
        []
      );
      return React.createElement(
        'FlashList',
        props,
        data.flatMap((item, index) =>
          React.createElement(Cell, { key: item.key, item, index, renderItem })
        ),
        ListFooterComponent
      );
    },
  };
});
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  RefreshControl: 'RefreshControl',
  Platform: platform,
  useWindowDimensions: () => ({ fontScale: 1, height: 844 }),
}));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useScrollToTop: () => undefined,
    useFocusEffect: (effect: () => void) => {
      useEffect(effect, [effect]);
    },
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    bottom: 0,
    left: controls.leftInset,
    right: controls.rightInset,
  }),
}));
vi.mock('@/components/agents/session-row', () => ({ StoredSessionRow: 'StoredSessionRow' }));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({
  History: 'History',
  SearchX: 'SearchX',
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/lib/a11y/announce', () => ({ moveA11yFocus: vi.fn() }));
vi.mock('@/lib/hooks/use-session-mutations', () => ({ useSessionMutations: () => controls }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#999999' }),
}));
vi.mock('@/lib/session-attention', () => ({ getRevisionSnapshot: () => 17 }));

function session(id: string): StoredSession {
  return {
    session_id: id,
    title: `${id} title`,
    organization_id: 'org-1',
    cloud_agent_session_id: null,
    cloud_agent_worktree_id: null,
    parent_session_id: null,
    created_on_platform: 'cli',
    git_url: null,
    git_branch: null,
    status: null,
    status_updated_at: null,
    total_cost_microdollars: null,
    created_at: '2026-08-28T10:00:00.000Z',
    updated_at: '2026-08-28T11:55:00.000Z',
    version: 0,
    associatedPr: null,
  };
}

type ContentProps = Parameters<typeof AgentSessionListContent>[0];
function contentProps(overrides: Partial<ContentProps> = {}): ContentProps {
  return {
    searchInputRef: { current: null },
    sections: [],
    activeSessionIds: new Set(),
    hasAnySessions: true,
    isLoading: false,
    isError: false,
    hasFreshHistory: true,
    isFetchingNextPage: false,
    refetch: vi.fn<ContentProps['refetch']>().mockResolvedValue(undefined),
    onRetry: () => undefined,
    onEndReached: () => undefined,
    onSessionPress: () => undefined,
    nonPullRefreshes: 0,
    hasActiveQuery: false,
    isSearching: false,
    searchQuery: '',
    onClearQuery: () => undefined,
    ...overrides,
  };
}
const mounted: TestRenderer.ReactTestRenderer[] = [];
function mount(props: ContentProps): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(AgentSessionListContent, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}
function isHost(node: TestRenderer.ReactTestInstance, type: string) {
  return node.type === type;
}
function hosts(renderer: TestRenderer.ReactTestRenderer, type: string) {
  return renderer.root.findAll(node => isHost(node, type));
}
function rows(renderer: TestRenderer.ReactTestRenderer) {
  return hosts(renderer, 'StoredSessionRow').map(node => {
    const { session: stored, live, metaWhileLive } = node.props as RowProps;
    return { id: stored.session_id, live, metaWhileLive };
  });
}
function press(node: TestRenderer.ReactTestInstance | undefined) {
  if (!node) {
    throw new Error('press target was not rendered');
  }
  const { onPress } = node.props as { onPress: () => void };
  act(onPress);
}

describe('AgentSessionListContent liveness', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    controls.scrollResets = 0;
    platform.OS = 'ios';
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount();
      }
    });
    mounted.length = 0;
  });

  it.each(['normal', 'filtered', 'searched', 'later-page'])(
    'updates %s rows without remounting or resetting scroll',
    mode => {
      let destination: Parameters<ContentProps['onSessionPress']> | undefined = undefined;
      const first = session('first');
      const later = session('later');
      const allSections = [{ title: 'Today', data: [first, later] }];
      let props: ContentProps = contentProps({
        sections: mode === 'later-page' ? [{ title: 'Today', data: [first] }] : allSections,
        activeSessionIds: new Set(['first', 'later title', 'active-only']),
        hasActiveQuery: mode === 'filtered' || mode === 'searched',
        isSearching: mode === 'searched',
        searchQuery: mode === 'searched' ? 'title' : '',
        onSessionPress: (...args) => {
          destination = args;
        },
        onEndReached: () => {
          props = { ...props, sections: allSections };
          renderer.update(createElement(AgentSessionListContent, props));
        },
      });
      const renderer = mount(props);
      const list = renderer.root.find(node => isHost(node, 'FlashList'));
      if (mode === 'later-page') {
        expect(rows(renderer)).toHaveLength(1);
        const { onEndReached } = list.props as ListProps;
        act(onEndReached);
      }
      expect(rows(renderer)).toEqual([
        { id: 'first', live: true, metaWhileLive: true },
        { id: 'later', live: false, metaWhileLive: true },
      ]);

      act(() => {
        renderer.update(
          createElement(AgentSessionListContent, {
            ...props,
            activeSessionIds: new Set(['later', 'active-only']),
          })
        );
      });
      expect(rows(renderer)).toEqual([
        { id: 'first', live: false, metaWhileLive: true },
        { id: 'later', live: true, metaWhileLive: true },
      ]);
      expect(hosts(renderer, 'FlashList')[0]).toBe(list);
      expect(list.props.extraData).toBe(17);
      expect(controls.scrollResets).toBe(0);
      press(hosts(renderer, 'StoredSessionRow')[1]);
      expect(destination).toEqual(['later', 'org-1', 'later title']);

      expect(hosts(renderer, 'StoredSessionRow').map(node => node.props.sortBy)).toEqual([
        'created_at',
        'created_at',
      ]);
    }
  );

  it.each([false, true])('preserves retry recovery for searching=%s', isSearching => {
    const recovered = contentProps({
      sections: [{ title: 'Today', data: [session('recovered')] }],
    });
    const renderer = mount(
      contentProps({
        isError: true,
        hasAnySessions: isSearching,
        hasActiveQuery: isSearching,
        isSearching,
        searchQuery: isSearching ? 'title' : '',
        onRetry: () => {
          renderer.update(createElement(AgentSessionListContent, recovered));
        },
      })
    );
    expect(hosts(renderer, 'AccessibleStatus').map(node => node.props.message)).toContain(
      i18n.t(isSearching ? 'agents.sessionList.couldNotSearch' : 'common.couldNotLoadSessions')
    );
    const retry = renderer.root.find(
      node => isHost(node, 'Button') && node.props.accessibilityLabel === 'Retry'
    );
    press(retry);
    expect(rows(renderer).map(item => item.id)).toEqual(['recovered']);
  });

  it.each([false, true])('keeps the clear control for empty searching=%s', isSearching => {
    const recovered = contentProps({
      sections: [{ title: 'Today', data: [session('recovered')] }],
    });
    const renderer = mount(
      contentProps({
        hasActiveQuery: true,
        isSearching,
        searchQuery: isSearching ? 'missing' : '',
        onClearQuery: () => {
          renderer.update(createElement(AgentSessionListContent, recovered));
        },
      })
    );
    const texts = hosts(renderer, 'Text').map(node => node.props.children);
    expect(texts).toContain(i18n.t('agents.sessionList.noMatches'));
    expect(texts).toContain(isSearching ? 'Clear search' : 'Clear filters');
    press(hosts(renderer, 'Button')[0]);
    expect(rows(renderer).map(item => item.id)).toEqual(['recovered']);
  });

  it('keeps empty history without a creation action even when active IDs exist', () => {
    const renderer = mount(
      contentProps({ hasAnySessions: false, activeSessionIds: new Set(['active-only']) })
    );
    expect(hosts(renderer, 'Text').map(node => node.props.children)).toContain('No past sessions');
    expect(hosts(renderer, 'Button')).toHaveLength(0);
    expect(hosts(renderer, 'FlashList')).toHaveLength(0);
    expect(rows(renderer)).toEqual([]);
  });

  it('retains cached live rows after a failed refetch', () => {
    const renderer = mount(
      contentProps({
        isError: true,
        sections: [{ title: 'Today', data: [session('cached')] }],
        activeSessionIds: new Set(['cached']),
      })
    );
    expect(rows(renderer)).toEqual([{ id: 'cached', live: true, metaWhileLive: true }]);
    // The reserved status line carries the failure: one inline
    // "Couldn't refresh" with a Retry action beside the kept rows.
    const statuses = hosts(renderer, 'AccessibleStatus');
    expect(statuses).toHaveLength(1);
    const [statusLine] = statuses;
    if (!statusLine) {
      throw new Error('no refresh status line rendered');
    }
    expect((statusLine.props as { message: string }).message).toBe("Couldn't refresh");
    const retry = hosts(renderer, 'Pressable').find(
      node => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Retry'
    );
    expect(retry).toBeDefined();
  });

  it('shows the retryable full-screen error when a fresh open finds only stale rows and the load failed', () => {
    // A fresh history open whose own load failed must not present rows left by
    // an earlier mount as loaded: the user gets the retryable error instead.
    const renderer = mount(
      contentProps({
        isError: true,
        hasFreshHistory: false,
        sections: [{ title: 'Today', data: [session('stale')] }],
        activeSessionIds: new Set(['stale']),
      })
    );
    expect(rows(renderer)).toEqual([]);
    expect(hosts(renderer, 'FlashList')).toHaveLength(0);
    expect(hosts(renderer, 'CenteredState')).toHaveLength(1);
    expect(hosts(renderer, 'AccessibleStatus').map(node => node.props.message)).toContain(
      i18n.t('common.couldNotLoadSessions')
    );
    expect(
      hosts(renderer, 'Button').some(
        node => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Retry'
      )
    ).toBe(true);
  });

  it('retires a stale pull failure when the screen settles a later non-pull refresh', () => {
    const hang = vi.fn<ContentProps['refetch']>(async () => {
      await new Promise<void>(() => {
        /* The hung-request shape: never settles on its own. */
      });
    });
    vi.useFakeTimers();
    try {
      const props = contentProps({
        sections: [{ title: 'Today', data: [session('cached')] }],
        refetch: hang,
      });
      const renderer = mount(props);
      // The pull hangs past the feedback budget: the reserved line fails over
      // to "Couldn't refresh" with Retry.
      const refreshControl = hosts(renderer, 'FlashList')[0]?.props.refreshControl as
        | { props: { onRefresh: () => void } }
        | undefined;
      act(() => {
        refreshControl?.props.onRefresh();
      });
      act(() => {
        vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
      });
      expect(hosts(renderer, 'AccessibleStatus').map(node => node.props.message)).toContain(
        "Couldn't refresh"
      );
      expect(
        hosts(renderer, 'Pressable').some(
          node => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Retry'
        )
      ).toBe(true);

      // The screen settles a refresh outside the pull lifecycle (focus return,
      // app foreground) afterwards: the stale gesture failure retires from an
      // up-to-date list even though the hung pull never settles.
      act(() => {
        renderer.update(createElement(AgentSessionListContent, { ...props, nonPullRefreshes: 1 }));
      });
      expect(hosts(renderer, 'AccessibleStatus').map(node => node.props.message)).not.toContain(
        "Couldn't refresh"
      );
      expect(
        hosts(renderer, 'Pressable').filter(
          node => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Retry'
        )
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { platform: 'ios' as const, floating: true },
    { platform: 'android' as const, floating: false },
  ])(
    'carries the in-flight pull on $platform without pinning the indicator over the first row',
    ({ platform: os, floating }) => {
      platform.OS = os;
      const hang = vi.fn<ContentProps['refetch']>(async () => {
        await new Promise<void>(() => {
          /* The hung-request shape: never settles on its own. */
        });
      });
      const renderer = mount(
        contentProps({
          sections: [{ title: 'Today', data: [session('cached')] }],
          refetch: hang,
        })
      );
      const control = () =>
        hosts(renderer, 'FlashList')[0]?.props.refreshControl as
          | ReactElement<{ refreshing: boolean; onRefresh: () => void }>
          | undefined;
      act(() => {
        control()?.props.onRefresh();
      });
      // Android's SwipeRefreshLayout rests its disc on the list's first row
      // (device defect uxs1), so the rows list mounts `RowsRefreshControl`,
      // which parks that disc below the fold (see its test); the reserved band
      // above the rows then shows the wait with a spinner that cannot cover a
      // row. iOS insets its content, so its native indicator stays.
      expect(control()?.type).toBe(RowsRefreshControl);
      expect(control()?.props.refreshing).toBe(true);
      const [status] = hosts(renderer, 'AccessibleStatus');
      expect(status?.props.message).toBe(i18n.t('agents.sessionList.updating'));
      expect(String(status?.props.className).includes('absolute')).toBe(floating);
      expect(hosts(renderer, 'ActivityIndicator')).toHaveLength(floating ? 0 : 1);
    }
  );

  it.each([
    { hasAnySessions: false },
    { hasAnySessions: false, isError: true },
    { hasActiveQuery: true, isSearching: true },
    { hasActiveQuery: true, isSearching: false },
    { hasActiveQuery: true, isSearching: true, isError: true },
    { hasActiveQuery: true, isSearching: false, isError: true },
  ])('centers a refreshable body outside the list for %j', async overrides => {
    const props = contentProps(overrides);
    const renderer = mount(props);
    const centered = hosts(renderer, 'CenteredState');
    expect(centered).toHaveLength(1);
    expect(hosts(renderer, 'FlashList')).toHaveLength(0);
    const refresh = centered[0]?.props.refreshControl as ReactElement<{ onRefresh: () => void }>;
    await act(async () => {
      refresh.props.onRefresh();
      await Promise.resolve();
    });
    expect(props.refetch).toHaveBeenCalledOnce();
  });

  it('keeps the loading skeletons instead of flashing empty history', () => {
    const renderer = mount(contentProps({ isLoading: true, hasAnySessions: false }));
    expect(hosts(renderer, 'Skeleton')).toHaveLength(8);
    expect(hosts(renderer, 'Button')).toHaveLength(0);
    expect(rows(renderer)).toEqual([]);
    // The skeleton rows ride in the list data: an empty-data loading state
    // would force the FlashList empty → populated transition that
    // mis-lays-out the swap to real rows (one stray row over a blank gap).
    // The mocked FlashList function component sits between the 'FlashList'
    // host and the content wrapper; it carries the `data` prop.
    const host = renderer.root.find(node => isHost(node, 'FlashList'));
    const composite = host.parent;
    if (!composite) {
      throw new Error('FlashList composite was not rendered');
    }
    expect((composite.props as ListProps).data.map(row => row.kind)).toEqual(
      Array.from({ length: 8 }, () => 'skeleton')
    );
  });

  it('sizes the loading skeletons to the stored session-row pitch', () => {
    // The reserved space must survive the skeleton → rows swap: each skeleton
    // slot (12dp wrapper padding + block) matches the SessionRow pitch
    // (py-[13px] + eyebrow/title ≈ 61dp), so rows land where skeletons stood.
    const renderer = mount(contentProps({ isLoading: true, hasAnySessions: false }));
    const skeletons = hosts(renderer, 'Skeleton');
    expect(skeletons).toHaveLength(8);
    for (const skeleton of skeletons) {
      expect(skeleton.props.className).toContain('h-[49px]');
    }
    const slots = hosts(renderer, 'View').filter(
      node => (node.props as { className?: string }).className === 'py-1.5'
    );
    expect(slots).toHaveLength(8);
  });

  it('swaps the reserved skeleton rows for real rows inside the same mounted list', () => {
    const loaded = contentProps({
      sections: [{ title: 'Today', data: [session('landed')] }],
    });
    const renderer = mount(contentProps({ isLoading: true, hasAnySessions: false }));
    const list = renderer.root.find(node => isHost(node, 'FlashList'));
    act(() => {
      renderer.update(createElement(AgentSessionListContent, loaded));
    });
    expect(rows(renderer).map(row => row.id)).toEqual(['landed']);
    expect(hosts(renderer, 'Skeleton')).toHaveLength(0);
    // One list stays mounted across the swap: no FlashList remount, so the
    // rows reuse the reserved space instead of relaying out from empty.
    expect(hosts(renderer, 'FlashList')[0]).toBe(list);
  });

  it('insets the FlashList wrapper by the landscape side insets', () => {
    const sections = [{ title: 'Today', data: [session('padded')] }];
    const renderer = mount(contentProps({ sections }));
    const list = renderer.root.find(node => isHost(node, 'FlashList'));
    const contentStyle = () =>
      (list.props as { contentContainerStyle: Record<string, number> }).contentContainerStyle;
    const wrapperStyle = () => {
      // The mock's FlashList composite sits between the host and the wrapper
      // View, so walk up to the first ancestor that carries a style.
      let node: TestRenderer.ReactTestInstance | null = list.parent;
      while (node && !(node.props as { style?: unknown }).style) {
        node = node.parent;
      }
      return (node?.props as { style?: Record<string, number> } | null)?.style;
    };
    const tabClearance = getEffectiveTabBarHeight({
      bottomInset: 0,
      platform: 'ios',
      fontScale: 1,
    });
    // Only the bottom tab-bar clearance stays on the content container.
    expect(contentStyle()).toEqual({ paddingBottom: tabClearance });

    // The landscape side insets live on the wrapper around the list.
    expect(wrapperStyle()).toEqual({ paddingLeft: 0, paddingRight: 0 });

    // Rotation pads only the sides; the tab-bar clearance is unchanged.
    controls.leftInset = 47;
    controls.rightInset = 59;
    act(() => {
      renderer.update(createElement(AgentSessionListContent, contentProps({ sections })));
    });
    expect(contentStyle()).toEqual({ paddingBottom: tabClearance });
    expect(wrapperStyle()).toEqual({ paddingLeft: 47, paddingRight: 59 });
  });

  it('renders date-section headers as ordinary in-flow rows', () => {
    const sections = [
      { title: 'Today', data: [session('a'), session('b')] },
      { title: 'Older', data: [session('c')] },
    ];
    const renderer = mount(contentProps({ sections }));
    expect(hosts(renderer, 'SessionListSectionHeader')).toHaveLength(2);
  });
});
