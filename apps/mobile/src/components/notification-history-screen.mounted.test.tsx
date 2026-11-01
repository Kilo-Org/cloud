/* eslint-disable max-lines -- one mounted harness: the paged list, its states, the chip filter, the row tap and the push banner share one fake tRPC surface */
import { createElement, type ReactElement, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationHistoryScreen } from '@/components/notification-history-screen';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

type Row = {
  id: string;
  category: string | null;
  pushType: string;
  payload: Record<string, unknown>;
  i18nKey: string | null;
  i18nParams: Record<string, string> | null;
  title: string;
  body: string;
  createdAt: string;
};

const HISTORY_PATH = ['user', 'getNotificationHistory'];

const NOW = Date.parse('2026-10-24T10:00:00.000Z');

type PreferencesFixture = { capabilities: Record<string, { available: boolean }> };
type GateFixture = {
  loading: boolean;
  settled: boolean;
  answered: boolean;
  permissionGranted: boolean;
  pushEnabled: boolean;
};

const state = vi.hoisted(() => {
  const preferences: PreferencesFixture | undefined = { capabilities: {} };
  const gate: GateFixture = {
    loading: false,
    settled: true,
    answered: true,
    permissionGranted: true,
    pushEnabled: true,
  };
  return {
    rows: [] as Row[],
    historyError: undefined as Error | undefined,
    preferencesError: undefined as Error | undefined,
    preferences,
    gate,
    /** The inputs `infiniteQueryOptions` was built with, newest last. */
    historyInputs: [] as { category?: string }[],
    /** The option objects the screen built, newest last. */
    historyOptions: [] as Record<string, unknown>[],
    /** Rows on page one while a fixture wants a second page. */
    pageSize: undefined as number | undefined,
    /** A failure for a non-first page only. */
    pageError: undefined as Error | undefined,
    /** The rendered list's paging hook, so a test can drive a next page. */
    listProps: undefined as { onEndReached?: () => void; onRefresh?: () => void } | undefined,
  };
});

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  setPendingDeepLink: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    onEndReached,
    onRefresh,
    ListFooterComponent,
  }: {
    data: Row[];
    renderItem: (info: { item: Row }) => ReactElement;
    onEndReached?: () => void;
    onRefresh?: () => void;
    ListFooterComponent?: ReactElement;
  }) => {
    state.listProps = { onEndReached, onRefresh };
    return createElement(
      'FlashList',
      null,
      data.map(item => createElement('Cell', { key: item.id }, renderItem({ item }))),
      ListFooterComponent ?? null
    );
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/components/ui/icons', () => ({ BellOff: 'BellOff' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 24 }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'jwt' }) }));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useRelativeTimeNow: () => NOW }));
vi.mock('@/lib/hooks/use-notification-master-gate', () => ({
  useNotificationMasterGate: () => state.gate,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#71717a' }),
}));
vi.mock('@/lib/deep-link-launch', () => ({
  setPendingDeepLink: mocks.setPendingDeepLink,
}));
vi.mock('@/lib/notification-actions', () => ({
  pendingDeepLinkOptionsForData: () => ({ sessionBound: false }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getNotificationHistory: {
        // tRPC's real shapes: the path is the first element, and only the path
        // prefix matches every variant of the read.
        pathKey: () => [HISTORY_PATH],
        infiniteQueryKey: (input: { category?: string }) => [
          HISTORY_PATH,
          { input, type: 'infinite' },
        ],
        infiniteQueryOptions: (input: { category?: string }, options: Record<string, unknown>) => {
          state.historyInputs.push(input);
          state.historyOptions.push(options);
          return {
            queryKey: [HISTORY_PATH, { input, type: 'infinite' }],
            initialPageParam: undefined,
            queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
              if (pageParam !== undefined && state.pageError) {
                throw state.pageError;
              }
              if (state.historyError) {
                throw state.historyError;
              }
              const items = state.rows.filter(
                entry => input.category === undefined || entry.category === input.category
              );
              if (state.pageSize === undefined) {
                return { items, nextCursor: null };
              }
              if (pageParam === undefined) {
                return {
                  items: items.slice(0, state.pageSize),
                  nextCursor: items.length > state.pageSize ? 'page-2' : null,
                };
              }
              return { items: items.slice(state.pageSize), nextCursor: null };
            },
            ...options,
          };
        },
      },
      getNotificationPreferences: {
        queryOptions: () => ({
          queryKey: ['user', 'getNotificationPreferences'],
          queryFn: () => {
            if (state.preferencesError) {
              throw state.preferencesError;
            }
            return state.preferences;
          },
        }),
      },
    },
  }),
}));

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    category: 'balanceAlerts',
    pushType: 'low_balance',
    payload: { type: 'low_balance', organizationId: 'org-acme' },
    i18nKey: 'internal.lowBalance',
    i18nParams: { organizationName: 'Acme', minimumBalanceUsd: '5' },
    title: 'stored title',
    body: 'stored body',
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

async function mount(): Promise<Awaited<ReturnType<typeof renderWithProviders>>> {
  view = await renderWithProviders(<NotificationHistoryScreen />);
  await waitFor(() => view?.renderer.root.findAllByType('Skeleton').length === 0);
  return view;
}

function byType(type: string) {
  const root = view?.renderer.root;
  if (!root) {
    throw new Error('screen not mounted');
  }
  return root.findAll(node => node.type === type);
}

/** Press a control; a missing control fails the test instead of a no-op. */
function press(node: ReactTestInstance | undefined) {
  if (!node) {
    throw new Error('control not mounted');
  }
  act(() => {
    (node.props.onPress as () => void)();
  });
}

/** The screen's button props, read once so the chip assertions stay typed. */
type ChipProps = { role?: string; accessibilityState?: { selected?: boolean } };

function chipProps(node: ReactTestInstance | undefined): ChipProps | undefined {
  return node?.props as ChipProps | undefined;
}

/** The footer's bottom padding, read once so the clearance assertion stays typed. */
function footerPadding(node: ReactTestInstance): number | undefined {
  return (node.props as { style?: { paddingBottom?: number } }).style?.paddingBottom;
}

/** The node whose `Text` child holds `value`. */
function withText(nodes: ReactTestInstance[], value: string) {
  return nodes.find(
    node =>
      node.findAll(
        child =>
          typeof child.type === 'string' &&
          (child.type as string) === 'Text' &&
          child.props.children === value
      ).length > 0
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  state.rows = [];
  state.historyError = undefined;
  state.preferencesError = undefined;
  state.preferences = { capabilities: {} };
  state.gate = {
    loading: false,
    settled: true,
    answered: true,
    permissionGranted: true,
    pushEnabled: true,
  };
  state.historyInputs = [];
  state.historyOptions = [];
  state.pageSize = undefined;
  state.pageError = undefined;
  state.listProps = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  onlineManager.setOnline(true);
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('NotificationHistoryScreen', () => {
  it('renders each row from the stored catalog key in the app language', async () => {
    state.rows = [row()];
    await mount();

    const texts = byType('Text').map(node => node.props.children);
    expect(texts).toContain('Low balance alert');
    expect(texts).toContain('Acme balance fell below $5');
    expect(texts).toContain('5 minutes ago');
    expect(texts).not.toContain('stored title');
  });

  it('filters the list by the tapped chip', async () => {
    state.rows = [row(), row({ id: 'row-2', category: 'chatMessages', pushType: 'chat.message' })];
    await mount();
    expect(byType('Cell')).toHaveLength(2);

    const chatChip = withText(byType('Button'), 'Chat messages');
    press(chatChip);

    await waitFor(() => byType('Cell').length === 1);
    expect(state.historyInputs.at(-1)).toMatchObject({ category: 'chatMessages' });
  });

  it('opens a row through the pending deep link slot, not the router', async () => {
    state.rows = [row()];
    await mount();

    const pressable = byType('Pressable')[0];
    press(pressable);

    expect(mocks.setPendingDeepLink).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/organization/credit-activity?org=org-acme',
      'notification',
      { sessionBound: false }
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps the list and reports a row whose stored payload no longer resolves', async () => {
    state.rows = [row({ payload: { type: 'retired_kind' } })];
    await mount();

    const pressable = byType('Pressable')[0];
    press(pressable);

    expect(mocks.toastError).toHaveBeenCalledWith('This notification no longer opens anywhere.');
    expect(mocks.setPendingDeepLink).not.toHaveBeenCalled();
    expect(byType('Cell')).toHaveLength(1);
  });

  it('states the retention window when the account has no rows', async () => {
    await mount();

    const empty = byType('EmptyState')[0];
    expect(empty?.props).toMatchObject({
      title: 'No notifications yet',
      description: 'Notifications this account receives appear here. They are kept for 90 days.',
    });
  });

  it('offers a retry when the first page fails', async () => {
    state.historyError = new Error('offline');
    await mount();

    const failure = byType('QueryError')[0];
    expect(failure?.props).toMatchObject({ message: 'Could not load notification history.' });
    expect(typeof failure?.props.onRetry).toBe('function');
  });

  it('shows the settings banner while the push gate is closed and still loads the list', async () => {
    state.gate = {
      loading: false,
      settled: true,
      answered: true,
      permissionGranted: false,
      pushEnabled: false,
    };
    state.rows = [row()];
    await mount();

    const banner = withText(byType('Button'), 'Notification settings');
    expect(banner).toBeDefined();
    expect(byType('Cell')).toHaveLength(1);

    press(banner);
    expect(mocks.push).toHaveBeenCalledWith('/(app)/notifications');
  });

  it('mounts the banner, the chips and the rows in one pass instead of pushing them later', async () => {
    // The push banner sits above the filters and the list. A banner that
    // mounted after either of them had settled would move them by its height,
    // so nothing under it renders while its gate is still answering.
    state.gate = {
      loading: true,
      settled: false,
      answered: false,
      permissionGranted: false,
      pushEnabled: false,
    };
    state.rows = [row()];
    let settle: (() => void) | undefined = undefined;
    function Harness() {
      const [, rerender] = useState(0);
      settle = () => {
        rerender(version => version + 1);
      };
      return <NotificationHistoryScreen />;
    }
    view = await renderWithProviders(<Harness />);
    // Both reads under the banner answer first; only the gate is still out.
    await waitFor(() => {
      const history = view?.queryClient.getQueryCache().findAll({ queryKey: [HISTORY_PATH] }) ?? [];
      return (
        history.length > 0 &&
        history.every(entry => entry.state.status === 'success') &&
        view?.queryClient.getQueryState(['user', 'getNotificationPreferences'])?.status ===
          'success'
      );
    });
    // The cache check above can pass one flush before the observer renders, so
    // let the resolved reads reach the tree before asserting on it.
    const settledTick = Promise.withResolvers<undefined>();
    setTimeout(() => {
      settledTick.resolve(undefined);
    }, 0);
    await act(async () => {
      await settledTick.promise;
    });
    expect(withText(byType('Button'), 'All')).toBeUndefined();
    expect(byType('Cell')).toHaveLength(0);

    state.gate = {
      loading: false,
      settled: true,
      answered: true,
      permissionGranted: false,
      pushEnabled: false,
    };
    act(() => {
      settle?.();
    });
    await waitFor(() => byType('Cell').length === 1);
    expect(withText(byType('Button'), 'Notification settings')).toBeDefined();
    expect(withText(byType('Button'), 'All')).toBeDefined();
  });

  it('claims nothing about pushes when the gate could not answer', async () => {
    // A failed read is not an answer: the banner may not tell the user their
    // pushes are off, and the rows still render.
    state.gate = {
      loading: false,
      settled: true,
      answered: false,
      permissionGranted: true,
      pushEnabled: false,
    };
    state.rows = [row()];
    await mount();

    const texts = byType('Text').map(node => node.props.children);
    expect(texts).not.toContain('Notification settings');
    expect(byType('Cell')).toHaveLength(1);
  });

  it('shows no banner while push reaches the device', async () => {
    state.rows = [row()];
    await mount();

    const texts = byType('Text').map(node => node.props.children);
    expect(texts).not.toContain('Notification settings');
  });

  it('announces the chip row as a tab list with the selected chip marked', async () => {
    state.rows = [row({ category: 'chatMessages', pushType: 'chat.message' })];
    await mount();

    const chip = withText(byType('Button'), 'Chat messages');
    expect(chipProps(chip)).toMatchObject({
      // iOS is the mocked platform: a chip is typed as a button there so
      // VoiceOver gives it a control trait (see lib/a11y/tab-entry).
      role: 'button',
      accessibilityState: { selected: false },
    });

    press(chip);
    await waitFor(
      () =>
        chipProps(withText(byType('Button'), 'Chat messages'))?.accessibilityState?.selected ===
        true
    );
  });

  it('says a category has nothing rather than that the account has nothing', async () => {
    state.rows = [row({ category: 'balanceAlerts' })];
    await mount();
    press(withText(byType('Button'), 'Chat messages'));
    await waitFor(() => byType('EmptyState').length === 1);

    const empty = byType('EmptyState')[0];
    expect(empty?.props).toMatchObject({ title: 'No notifications in this category' });
    // The retention window describes the whole list, not one empty category.
    expect(empty?.props.description).toBeUndefined();
  });

  it('collapses retained pages on a refresh instead of re-reading their cursors', async () => {
    state.pageSize = 3;
    state.rows = [1, 2, 3, 4, 5].map(index =>
      row({ id: `row-${index}`, title: `stored ${index}` })
    );
    await mount();
    expect(byType('Cell')).toHaveLength(3);

    act(() => {
      state.listProps?.onEndReached?.();
    });
    await waitFor(() => byType('Cell').length === 5);

    act(() => {
      state.listProps?.onRefresh?.();
    });
    await waitFor(() => byType('Cell').length === 3);
  });

  it('reports a refresh that fails instead of leaving the list silent', async () => {
    state.rows = [row()];
    await mount();

    state.historyError = new Error('offline');
    act(() => {
      state.listProps?.onRefresh?.();
    });

    await waitFor(() => mocks.toastError.mock.calls.length > 0);
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't refresh. Pull down to try again.");
  });

  it('keeps the tab-bar clearance under the next-page retry', async () => {
    state.pageSize = 1;
    state.rows = [row({ id: 'row-1' }), row({ id: 'row-2' })];
    await mount();

    state.pageError = new Error('paging failed');
    act(() => {
      state.listProps?.onEndReached?.();
    });
    await waitFor(() => withText(byType('Button'), 'Retry loading more') !== undefined);

    // 24dp of tab bar plus the footer's own 32dp.
    const footer = byType('View').find(node => footerPadding(node) === 56);
    expect(footer).toBeDefined();
  });

  it('settles the chip row offline instead of holding its skeletons', async () => {
    // The online manager reports offline, so a read that keeps the default
    // `networkMode: 'online'` pauses in `pending` and never renders a chip.
    onlineManager.setOnline(false);
    state.preferencesError = new Error('offline');
    await mount();

    expect(withText(byType('Button'), 'All')).toBeDefined();
    expect(withText(byType('Button'), 'Chat messages')).toBeDefined();
  });

  it('turns off the network gate so an offline first load can fail into its retry', async () => {
    state.rows = [row()];
    await mount();

    expect(state.historyOptions.at(-1)).toMatchObject({ networkMode: 'always' });
  });
});
