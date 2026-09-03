/* eslint-disable max-lines, typescript-eslint/no-deprecated -- the four history paths and recovery controls share one native list harness; react-test-renderer mounts it without a DOM. */
import { createElement, type ReactElement, type ReactNode, type Ref } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { AgentSessionListContent } from './session-list-content';
import { type SessionSection } from './session-list-helpers';
import { type StoredSessionRow } from './session-row';

type RowProps = Parameters<typeof StoredSessionRow>[0];
type CellProps = {
  item: StoredSession;
  renderItem: (info: { item: StoredSession }) => ReactElement;
};
type ListProps = {
  sections: SessionSection[];
  renderItem: CellProps['renderItem'];
  ListEmptyComponent: ReactNode;
  ListFooterComponent: ReactNode;
  ref?: Ref<{ getScrollResponder: () => { scrollTo: () => void } }>;
  extraData: number;
  onEndReached: () => void;
};
const controls = vi.hoisted(() => ({
  scrollResets: 0,
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', async () => {
  const React = await import('react');
  // Virtualized cells reuse their renderer until its identity changes. This
  // catches a stale live-set closure even when the list itself re-renders.
  const Cell = React.memo(function SessionCell({ item, renderItem }: CellProps) {
    return renderItem({ item });
  });
  return {
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    RefreshControl: 'RefreshControl',
    Platform: { OS: 'ios' },
    useWindowDimensions: () => ({ fontScale: 1 }),
    SectionList: ({
      sections,
      renderItem,
      ListEmptyComponent,
      ListFooterComponent,
      ref,
      ...props
    }: ListProps) => {
      React.useImperativeHandle(
        ref,
        () => ({
          getScrollResponder: () => ({
            scrollTo: () => {
              controls.scrollResets += 1;
            },
          }),
        }),
        []
      );
      return React.createElement(
        'SectionList',
        props,
        sections.flatMap(section =>
          section.data.map(item =>
            React.createElement(Cell, { key: item.session_id, item, renderItem })
          )
        ),
        sections.length === 0 ? ListEmptyComponent : null,
        ListFooterComponent
      );
    },
  };
});
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
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/components/agents/session-row', () => ({ StoredSessionRow: 'StoredSessionRow' }));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
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
    isFetchingNextPage: false,
    refetch: vi.fn<ContentProps['refetch']>().mockResolvedValue(undefined),
    onRetry: () => undefined,
    onEndReached: () => undefined,
    onSessionPress: () => undefined,
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
      const list = renderer.root.find(node => isHost(node, 'SectionList'));
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
      expect(hosts(renderer, 'SectionList')[0]).toBe(list);
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
      i18n.t(isSearching ? 'agents.sessionList.couldNotSearch' : 'agents.sessionList.couldNotLoad')
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
    expect(hosts(renderer, 'SectionList')).toHaveLength(0);
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
    expect(hosts(renderer, 'AccessibleStatus')).toHaveLength(0);
  });

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
    expect(hosts(renderer, 'SectionList')).toHaveLength(0);
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
  });
});
