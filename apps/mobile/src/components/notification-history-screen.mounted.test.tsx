import { createElement, type ReactElement } from 'react';
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

const NOW = Date.parse('2026-10-24T10:00:00.000Z');

type PreferencesFixture = { capabilities: Record<string, { available: boolean }> };
type GateFixture = {
  loading: boolean;
  settled: boolean;
  permissionGranted: boolean;
  pushEnabled: boolean;
};

const state = vi.hoisted(() => {
  const preferences: PreferencesFixture | undefined = { capabilities: {} };
  const gate: GateFixture = {
    loading: false,
    settled: true,
    permissionGranted: true,
    pushEnabled: true,
  };
  return {
    rows: [] as Row[],
    historyError: undefined as Error | undefined,
    preferences,
    gate,
    /** The inputs `infiniteQueryOptions` was built with, newest last. */
    historyInputs: [] as { category?: string }[],
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
  }: {
    data: Row[];
    renderItem: (info: { item: Row }) => ReactElement;
  }) =>
    createElement(
      'FlashList',
      null,
      data.map(item => createElement('Cell', { key: item.id }, renderItem({ item })))
    ),
}));

vi.mock('react-native', () => ({
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
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'jwt' }) }));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useNowTicker: () => NOW }));
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
        infiniteQueryOptions: (input: { category?: string }, options: object) => {
          state.historyInputs.push(input);
          return {
            queryKey: ['user', 'getNotificationHistory', input],
            initialPageParam: undefined,
            queryFn: () => {
              if (state.historyError) {
                throw state.historyError;
              }
              const items = state.rows.filter(
                entry => input.category === undefined || entry.category === input.category
              );
              return { items, nextCursor: null };
            },
            ...options,
          };
        },
      },
      getNotificationPreferences: {
        queryOptions: () => ({
          queryKey: ['user', 'getNotificationPreferences'],
          queryFn: () => state.preferences,
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
  state.preferences = { capabilities: {} };
  state.gate = { loading: false, settled: true, permissionGranted: true, pushEnabled: true };
  state.historyInputs = [];
  vi.clearAllMocks();
});

afterEach(() => {
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
    state.gate = { loading: false, settled: true, permissionGranted: false, pushEnabled: false };
    state.rows = [row()];
    await mount();

    const banner = withText(byType('Button'), 'Notification settings');
    expect(banner).toBeDefined();
    expect(byType('Cell')).toHaveLength(1);

    press(banner);
    expect(mocks.push).toHaveBeenCalledWith('/(app)/notifications');
  });

  it('shows no banner while push reaches the device', async () => {
    state.rows = [row()];
    await mount();

    const texts = byType('Text').map(node => node.props.children);
    expect(texts).not.toContain('Notification settings');
  });
});
