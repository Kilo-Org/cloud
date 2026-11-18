// Test support for blocked-people-screen.mounted.test.tsx: the module-mock
// harness, the screen state the mocks read, and the mount/query helpers. The
// vi.mock registrations in this module body run while it is evaluated — which
// is why the test file must import this module FIRST, before the screen or any
// other module that has to resolve against these mocks.

import { createElement, type ElementType } from 'react';
import { type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { BlockedPeopleScreen } from './blocked-people-screen';
import type * as ReactQuery from '@tanstack/react-query';

type MutationOptions = {
  onSuccess?: (result: unknown, input: { githubLogin: string }) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type ScreenState = {
  blockedLogins: string[];
  mutedLogins: string[];
  error: boolean;
  hasData: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isFetching: boolean;
  isRefetching: boolean;
  connectivity: 'online' | 'offline' | 'unknown';
  errorCode: string | undefined;
  mutations: Record<string, MutationOptions>;
  pending: string | null;
  pendingVariables: { githubLogin: string } | null;
  calls: { name: string; input: unknown }[];
  toastError: Mock;
  lastRefreshControl: { props: { refreshing: boolean; onRefresh: unknown } } | null;
};

export const state = vi.hoisted((): ScreenState => ({
  blockedLogins: [],
  mutedLogins: [],
  error: false,
  hasData: true,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  isFetching: false,
  isRefetching: false,
  connectivity: 'online' as 'online' | 'offline' | 'unknown',
  errorCode: undefined as string | undefined,
  mutations: {},
  pending: null,
  pendingVariables: null,
  calls: [],
  toastError: vi.fn(),
  lastRefreshControl: null as { props: { refreshing: boolean; onRefresh: unknown } } | null,
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.hasData
        ? { blockedLogins: state.blockedLogins, mutedLogins: state.mutedLogins }
        : null,
      isPending: !state.hasData && !state.error,
      isError: state.error,
      isFetching: state.isFetching,
      isRefetching: state.isRefetching,
      fetchStatus: state.fetchStatus,
      error: state.error
        ? Object.assign(new Error('refetch failed'), { data: { code: state.errorCode } })
        : null,
      refetch: vi.fn(),
    }),
    useMutation: (options: { kind: string } & MutationOptions) => {
      state.mutations[options.kind] = options;
      const pending = state.pending === options.kind;
      return {
        mutate: (input: unknown) => {
          state.calls.push({ name: options.kind, input });
        },
        isPending: pending,
        variables: pending ? state.pendingVariables : undefined,
      };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock('sonner-native', () => ({
  toast: { error: state.toastError, success: vi.fn() },
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      listHiddenUsers: { queryOptions: () => ({}), queryKey: () => [] },
      unblockUser: {
        mutationOptions: (options: MutationOptions) => ({ kind: 'unblock', ...options }),
      },
      unmuteUser: {
        mutationOptions: (options: MutationOptions) => ({ kind: 'unmute', ...options }),
      },
    },
  }),
}));
vi.mock('@/components/ui/icons', () => ({ Ban: 'Ban', BellOff: 'BellOff' }));
// The row primitives notify a selection through the haptic bridge, which loads
// the expo runtime; the suite asserts structure, not feedback.
vi.mock('@/lib/haptics', () => ({
  impactHaptic: () => undefined,
  notificationHaptic: () => undefined,
  selectionHaptic: () => undefined,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown; refreshControl?: unknown }) => {
    if (props.refreshControl) {
      state.lastRefreshControl = props.refreshControl as {
        props: { refreshing: boolean; onRefresh: unknown };
      };
    }
    return props.children;
  },
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => state.connectivity,
}));

export const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

export async function mount() {
  const view = await renderWithProviders(createElement(BlockedPeopleScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

export function action(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(
    node => Object.is(node.type, BUTTON) && node.props.accessibilityLabel === label
  );
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one ${label} action, found ${found.length}`);
  }
  return only;
}

export function texts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

export function resetState() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.blockedLogins = ['spammer'];
  state.mutedLogins = ['loudmouth'];
  state.error = false;
  state.hasData = true;
  state.fetchStatus = 'idle';
  state.isRefetching = false;
  state.isFetching = false;
  state.connectivity = 'online';
  state.errorCode = undefined;
  state.mutations = {};
  state.calls = [];
  state.pending = null;
  state.pendingVariables = null;
  state.toastError.mockClear();
  state.lastRefreshControl = null;
}

export function unmountBlockedPeople() {
  act(() => renderer?.unmount());
  renderer = undefined;
}
