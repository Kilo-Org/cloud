import { act, createElement, Fragment, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { type ShareCliSpawnRow } from './share-cli-spawn';
import { ShareDestinationList } from './share-destination-list';
import { type ShareDestinationRow } from './share-destinations';
import { type ShareGateState } from './share-gate-state';

vi.mock('react-native', () => ({
  View: 'View',
  TextInput: 'TextInput',
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: readonly ShareDestinationRow[];
    getItemType?: (item: unknown) => string;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    renderItem: (info: { item: ShareDestinationRow }) => ReactNode;
  }) => {
    const data = props.data ?? [];
    return createElement(
      'FlashList',
      { getItemType: props.getItemType },
      props.ListHeaderComponent,
      data.length > 0
        ? data.map(
            (item, index): ReactNode =>
              createElement(Fragment, { key: index }, props.renderItem({ item }))
          )
        : props.ListEmptyComponent
    );
  },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 12 }) }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', Terminal: 'Terminal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SectionHeader',
}));
vi.mock('@/components/agents/session-row', () => ({ StoredSessionRow: 'StoredSessionRow' }));
vi.mock('@/components/destination-option-row', () => ({
  DestinationOptionRow: 'DestinationOptionRow',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));

const instance: ShareCliSpawnRow = {
  connectionId: 'cli-1',
  name: 'Laptop',
  projectName: 'project',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};
const empty: ShareGateState = {
  kind: 'empty',
  message: 'No sessions',
  showNewSession: true,
  showRetry: false,
  showList: false,
};
const retryable: ShareGateState = {
  kind: 'retryable',
  message: 'Failed to load',
  showNewSession: true,
  showRetry: true,
  showList: false,
};
const happy: ShareGateState = {
  kind: 'happy',
  showNewSession: true,
  showRetry: false,
  showList: true,
  listMode: 'rows',
};
const destinations = Array.from({ length: 9 }, (_, index) => ({
  session_id: `session-${index}`,
  title: `Task ${index}`,
  git_branch: 'main',
  live: false,
})) as ShareDestinationRow[];

async function mount(
  state: ShareGateState,
  instances: ShareCliSpawnRow[] = [],
  rows: ShareDestinationRow[] = []
) {
  const onRetry = vi.fn<() => void>();
  const onSelect = vi.fn<(row: ShareDestinationRow) => void>();
  const onSpawnInstance = vi.fn<(row: ShareCliSpawnRow) => void>();
  const mounted = await renderWithProviders(
    createElement(ShareDestinationList, {
      headerContent: createElement('Header'),
      state,
      destinations: rows,
      instances,
      spawningConnectionId: null,
      instanceRowsDisabled: false,
      destinationsDisabled: false,
      onRetry,
      onSelect,
      onSpawnInstance,
    })
  );
  return mounted;
}

describe('ShareDestinationList surface states', () => {
  it.each([empty, retryable])(
    'lifts $kind outside the list without connected CLI choices',
    async state => {
      const { renderer, unmount } = await mount(state);
      expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(0);
      const bodyType = state.kind === 'retryable' ? 'QueryError' : 'CenteredState';
      const body = renderer.root.find(node => String(node.type) === bodyType);
      expect((body.props as { placement?: string }).placement).not.toBe('top');
      expect(renderer.toJSON()).toHaveLength(2);
      unmount();
    }
  );

  it.each([empty, retryable])('keeps $kind inline beside connected CLI choices', async state => {
    const { renderer, unmount } = await mount(state, [instance]);
    const list = renderer.root.find(node => String(node.type) === 'FlashList');
    expect(list.findAll(node => String(node.type) === 'DestinationOptionRow')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(0);
    if (state.kind === 'retryable') {
      expect(list.find(node => String(node.type) === 'QueryError').props).toMatchObject({
        placement: 'top',
      });
    }
    unmount();
  });

  it.each(['stale-share', 'non-retryable-classification'] as const)(
    'centers %s instead of an empty list',
    async kind => {
      const { renderer, unmount } = await mount(
        {
          kind,
          message: 'Unavailable share',
          showNewSession: false,
          showRetry: false,
          showList: false,
        },
        [instance]
      );
      expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
      expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(0);
      expect(
        renderer.root.findAll(node => String(node.type) === 'DestinationOptionRow')
      ).toHaveLength(0);
      unmount();
    }
  );

  it('keeps the search input mounted across empty and populated results', async () => {
    const { renderer, unmount } = await mount(happy, [], destinations);
    const input = renderer.root.find(node => String(node.type) === 'TextInput');
    const onChangeText = (input.props as { onChangeText: (text: string) => void }).onChangeText;
    const header = renderer.root.find(
      node => (node.props as { collapsable?: boolean }).collapsable === false
    );
    expect(header.findAll(node => String(node.type) === 'Header')).toHaveLength(1);
    act(() => {
      onChangeText('no match');
    });
    expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
    expect(renderer.root.find(node => String(node.type) === 'TextInput')).toBe(input);
    act(() => {
      onChangeText('main');
    });
    expect(renderer.root.findAll(node => String(node.type) === 'StoredSessionRow')).toHaveLength(9);
    expect(renderer.root.find(node => String(node.type) === 'TextInput')).toBe(input);
    unmount();
  });

  it('gives every destination row one constant item type', async () => {
    const { renderer, unmount } = await mount(happy, [], destinations);
    const list = renderer.root.find(node => String(node.type) === 'FlashList');
    const getItemType = (list.props as { getItemType?: (item: unknown) => string }).getItemType;
    expect(getItemType).toBeTypeOf('function');
    expect(getItemType?.(destinations[0])).toBe('destination');
    act(() => {
      (
        renderer.root.find(node => String(node.type) === 'TextInput').props as {
          onChangeText: (text: string) => void;
        }
      ).onChangeText('main');
    });
    // The identity is the hoisted `useCallback`, so a parent re-render does not
    // invalidate the list's recycling.
    const rerendered = renderer.root.find(node => String(node.type) === 'FlashList');
    expect((rerendered.props as { getItemType?: unknown }).getItemType).toBe(getItemType);
    unmount();
  });

  it('keeps connected CLI choices when search removes every session', async () => {
    const { renderer, unmount } = await mount(happy, [instance], destinations);
    const input = renderer.root.find(node => String(node.type) === 'TextInput');
    act(() => {
      (input.props as { onChangeText: (text: string) => void }).onChangeText('no match');
    });
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(0);
    expect(
      renderer.root.findAll(node => String(node.type) === 'DestinationOptionRow')
    ).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'StoredSessionRow')).toHaveLength(0);
    unmount();
  });

  it('keeps the loading skeleton ahead of empty states', async () => {
    const { renderer, unmount } = await mount({
      kind: 'loading',
      showNewSession: true,
      showRetry: false,
      showList: true,
      listMode: 'skeleton',
    });
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(5);
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(0);
    unmount();
  });
});
