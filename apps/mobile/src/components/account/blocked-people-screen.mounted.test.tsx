import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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

const state = vi.hoisted((): ScreenState => ({
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

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(BlockedPeopleScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function action(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(
    node => Object.is(node.type, BUTTON) && node.props.accessibilityLabel === label
  );
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one ${label} action, found ${found.length}`);
  }
  return only;
}

function texts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

beforeEach(() => {
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
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('BlockedPeopleScreen', () => {
  it('separates blocked people from muted people', async () => {
    const root = await mount();

    expect(texts(root)).toEqual(
      expect.arrayContaining(['Blocked people', 'Muted people', 'spammer', 'loudmouth'])
    );
  });

  it('unblocks a login directly, without a confirmation', async () => {
    const root = await mount();

    act(() => {
      (action(root, 'Unblock spammer').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'unblock', input: { githubLogin: 'spammer' } }]);
  });

  it('unmutes a login directly', async () => {
    const root = await mount();

    act(() => {
      (action(root, 'Unmute loudmouth').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'unmute', input: { githubLogin: 'loudmouth' } }]);
  });

  it('keeps each list independent while a reveal is in flight', async () => {
    state.pending = 'unblock';
    state.pendingVariables = { githubLogin: 'spammer' };
    const root = await mount();

    expect(action(root, 'Unblock spammer').props.disabled).toBe(true);
    expect(action(root, 'Unmute loudmouth').props.disabled).toBe(false);

    act(() => renderer?.unmount());
    renderer = undefined;

    state.pending = 'unmute';
    state.pendingVariables = { githubLogin: 'loudmouth' };
    const second = await mount();

    expect(action(second, 'Unblock spammer').props.disabled).toBe(false);
    expect(action(second, 'Unmute loudmouth').props.disabled).toBe(true);
  });

  it('ignores a second tap in the same list while the first is pending', async () => {
    state.blockedLogins = ['spammer', 'second-blocked'];
    state.pending = 'unblock';
    state.pendingVariables = { githubLogin: 'spammer' };
    const root = await mount();

    expect(action(root, 'Unblock spammer').props.disabled).toBe(true);
    expect(action(root, 'Unblock second-blocked').props.disabled).toBe(true);
    expect(action(root, 'Unblock second-blocked').props.loading).toBe(false);
    expect(action(root, 'Unmute loudmouth').props.disabled).toBe(false);
  });

  it('shows the server message when a reveal is refused', async () => {
    await mount();

    act(() => {
      state.mutations.unblock?.onSettled?.();
      state.mutations.unblock?.onError?.(new Error('That account is no longer hidden'));
    });

    expect(state.toastError).toHaveBeenCalledWith('That account is no longer hidden');
  });

  it('has one empty state when nobody is hidden', async () => {
    state.blockedLogins = [];
    state.mutedLogins = [];
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['Nobody is hidden']);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  it('keeps a full retry state when the lists cannot be read at all', async () => {
    state.hasData = false;
    state.error = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
    expect(texts(root)).not.toContain('spammer');
  });

  it('keeps rows and adds an error notice when a refetch fails with cache', async () => {
    state.error = true;
    const root = await mount();

    expect(texts(root)).toEqual(expect.arrayContaining(['spammer', 'loudmouth']));
    const notices = root.findAll(node => Object.is(node.type, 'QueryError'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.props.onRetry).toBeTypeOf('function');
  });

  it('names the refreshed notice after the failure kind', async () => {
    state.error = true;
    state.connectivity = 'offline';
    const offline = await mount();
    expect(offline.find(node => Object.is(node.type, 'QueryError')).props.variant).toBe('offline');

    state.connectivity = 'online';
    state.errorCode = 'INTERNAL_SERVER_ERROR';
    const failed = await mount();
    expect(failed.find(node => Object.is(node.type, 'QueryError')).props.variant).toBe('server');
  });

  it('keeps the stale notice mounted while its retry runs', async () => {
    // A notice gated on `!isFetching` would unmount on the tap that starts the
    // retry, so the reader saw the notice vanish instead of its spinner.
    state.fetchStatus = 'paused';
    state.connectivity = 'offline';
    const idle = await mount();
    expect(idle.find(node => Object.is(node.type, 'QueryError')).props.isRetrying).toBe(false);

    state.isFetching = true;
    const retrying = await mount();
    const notice = retrying.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.isRetrying).toBe(true);
    expect(notice.props.onRetry).toBeTypeOf('function');
  });

  it('keeps the generic pause copy while connectivity is unsettled', async () => {
    state.fetchStatus = 'paused';
    state.connectivity = 'unknown';
    const root = await mount();

    const notice = root.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.variant).toBe('neutral');
  });

  it('names the offline pause of a cold first read instead of the skeleton', async () => {
    state.hasData = false;
    state.fetchStatus = 'paused';
    state.connectivity = 'offline';
    const root = await mount();

    const errors = root.findAll(node => Object.is(node.type, 'QueryError'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('offline');
    expect(errors[0]?.props.onRetry).toBeTypeOf('function');
    expect(root.findAll(node => Object.is(node.type, 'Skeleton'))).toHaveLength(0);
  });

  it('keeps the skeleton for a cold first read while connectivity is unsettled', async () => {
    state.hasData = false;
    state.fetchStatus = 'paused';
    state.connectivity = 'unknown';
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, 'Skeleton'))).not.toHaveLength(0);
  });

  it('offers pull to refresh wired to the read refetch', async () => {
    await mount();
    expect(state.lastRefreshControl).toBeTruthy();
    const control = state.lastRefreshControl;
    if (!control) {
      throw new Error('refresh control missing');
    }
    expect(control.props.refreshing).toBe(false);
    expect(control.props.onRefresh).toBeTypeOf('function');
    state.isRefetching = true;
    const refreshing = await mount();
    expect(state.lastRefreshControl?.props.refreshing).toBe(true);
    expect(refreshing.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(0);
  });
});
