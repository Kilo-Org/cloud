/* eslint-disable max-lines -- one mounted suite covers the picker's resync affordances and its config-read states */

// The repository picker's plain read answers from the integration snapshot, so
// the screen must offer the two ways out of a short or stale list: the provider
// settings page that widens installation access, and a resync that ignores the
// snapshot. A non-empty list is exactly where the old screen offered neither.

import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act } from '@/test/renderer';
import ReposRoute from './repos';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

type AppStateHandler = (nextState: string) => void;

type ButtonPressProps = { onPress?: () => void; loading?: boolean; disabled?: boolean };

type PullControl = { props: { onRefresh?: () => void; refreshing?: boolean } };

const state = vi.hoisted(() => ({
  platform: 'github' as 'github' | 'gitlab' | 'bitbucket',
  repositories: [] as { id: number; fullName: string; private: boolean }[],
  syncedAt: null as string | null,
  resync: vi.fn(() => Promise.resolve()),
  resyncing: false,
  readinessRefetch: vi.fn(),
  readinessFetching: false,
  readiness: null as unknown,
  openManageAccess: undefined as (() => Promise<void>) | undefined,
  appStateHandler: null as AppStateHandler | null,
  config: {
    data: { repositorySelectionMode: 'selected', selectedRepositoryIds: [] } as unknown,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle' as string,
    refetch: vi.fn(),
  },
  queryErrorProps: [] as { variant?: string; onRetry?: () => void; isRetrying?: boolean }[],
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => true }),
}));

vi.mock('@/lib/hooks/use-reviewer-route-params', () => ({
  useReviewerRouteParams: () => ({ scope: 'org-1', platform: state.platform }),
}));

vi.mock('react-native', () => ({
  View: 'View',
  AppState: {
    addEventListener: (event: string, handler: AppStateHandler) => {
      if (event === 'change') {
        state.appStateHandler = handler;
      }
      return { remove: vi.fn() };
    },
  },
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children?: ReactNode }) =>
    createElement('CenteredState', null, props.children),
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }): ReactNode => {
    state.queryErrorProps.push(props);
    return createElement('QueryError', props);
  },
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; action?: ReactNode }) =>
    createElement('EmptyState', { title: props.title }, props.action),
}));
vi.mock('@/components/repo-toggle-row', () => ({ RepoToggleRow: 'RepoToggleRow' }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: {
    children?: ReactNode;
    onPress?: () => void;
    loading?: boolean;
    disabled?: boolean;
  }) =>
    createElement(
      'Button',
      { onPress: props.onPress, loading: props.loading, disabled: props.disabled },
      props.children
    ),
}));
vi.mock('@/components/ui/choice-row', () => ({
  ChoiceRow: (props: { label: string; selected: boolean; onPress?: () => void }) =>
    createElement('ChoiceRow', props),
}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: (props: { children?: ReactNode }) =>
    createElement('RadioGroup', null, props.children),
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ FolderGit2: 'FolderGit2' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode; refreshControl?: ReactNode }) =>
    createElement('ScrollView', { refreshControl: props.refreshControl }, props.children),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/integration-urls', () => ({
  getBitbucketIntegrationUrl: () => 'https://example.test/bitbucket',
  getGitLabIntegrationUrl: () => 'https://example.test/gitlab',
}));
vi.mock('@/lib/utils', () => ({
  parseTimestamp: (value: string) => new Date(value),
  timeAgo: () => '2 days ago',
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useReviewConfig: () => state.config,
  useSaveReviewConfig: () => ({ mutate: vi.fn() }),
  useGitHubRepositories: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      repositories: state.platform === 'github' ? state.repositories : [],
      syncedAt: state.syncedAt,
    },
  }),
  useGitLabRepositories: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: {
      repositories: state.platform === 'gitlab' ? state.repositories : [],
      syncedAt: state.syncedAt,
    },
  }),
  useBitbucketReadiness: () => ({
    isLoading: false,
    isError: false,
    isFetching: state.readinessFetching,
    refetch: state.readinessRefetch,
    data: state.readiness,
  }),
}));
vi.mock('@/lib/hooks/use-code-reviewer-repo-sync', () => ({
  useReviewerRepositoriesResync: () => ({ resync: state.resync, resyncing: state.resyncing }),
}));
vi.mock('@/lib/hooks/use-code-reviewer-manage-access', () => ({
  useManageRepositoryAccess: () => state.openManageAccess,
}));
vi.mock('@/lib/hooks/use-code-reviewer-repo-selection', () => ({
  useRepoSelectionToggle: () => vi.fn(),
}));

const REPOSITORIES = [
  { id: 7000001, fullName: 'acme/acme-repo-1', private: false },
  { id: 7000002, fullName: 'acme/acme-repo-2', private: false },
];

type Mounted = RenderWithProvidersResult;

function buttons(renderer: Mounted['renderer']) {
  return renderer.root
    .findAll(node => String(node.type) === 'Button')
    .map(node => {
      const [text] = node.findAll(child => String(child.type) === 'Text');
      const label = text?.props.children;
      return {
        label: typeof label === 'string' ? label : '',
        props: node.props as ButtonPressProps,
      };
    });
}

function button(renderer: Mounted['renderer'], label: string) {
  return buttons(renderer).find(candidate => candidate.label === label)?.props;
}

function pullControl(renderer: Mounted['renderer']) {
  const [scrollView] = renderer.root.findAll(node => String(node.type) === 'ScrollView');
  const control = scrollView?.props.refreshControl as PullControl | undefined;
  if (!control) {
    throw new Error('the repository list rendered no pull control');
  }
  return control;
}

beforeEach(() => {
  state.platform = 'github';
  state.repositories = REPOSITORIES;
  state.syncedAt = '2026-10-20T06:04:13.436632+00';
  state.resync.mockClear();
  state.resyncing = false;
  state.readinessRefetch.mockClear();
  state.readinessFetching = false;
  state.readiness = null;
  state.openManageAccess = vi.fn<() => Promise<void>>(() => Promise.resolve());
  state.appStateHandler = null;
  state.config.data = { repositorySelectionMode: 'selected', selectedRepositoryIds: [] };
  state.config.isError = false;
  state.config.isFetching = false;
  state.config.fetchStatus = 'idle';
  state.config.refetch.mockReset();
  state.queryErrorProps = [];
});

describe('repository picker resync affordance', () => {
  it('offers Manage access, Refresh and the sync time below a non-empty list', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    expect(buttons(renderer).map(candidate => candidate.label)).toEqual([
      'Refresh',
      'Manage access',
    ]);
    expect(
      renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children)
    ).toContain('Last synced 2 days ago');
    unmount();
  });

  it('omits the sync time when the response carries none', async () => {
    state.syncedAt = null;
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    expect(
      renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children)
    ).not.toContain('Last synced 2 days ago');
    unmount();
  });

  it('keeps Manage access on an empty list and drops the footer', async () => {
    state.repositories = [];
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(
      () => renderer.root.findAll(node => String(node.type) === 'EmptyState').length === 1
    );

    expect(button(renderer, 'Refresh')).toBeUndefined();
    expect(button(renderer, 'Manage access')).toBeDefined();
    unmount();
  });

  it('forces a sync from the footer button and from the pull gesture', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    button(renderer, 'Refresh')?.onPress?.();
    expect(state.resync).toHaveBeenCalledTimes(1);

    pullControl(renderer).props.onRefresh?.();
    expect(state.resync).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('shows the busy state while a forced sync runs', async () => {
    state.resyncing = true;
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    expect(button(renderer, 'Refresh')?.loading).toBe(true);
    expect(button(renderer, 'Refresh')?.disabled).toBe(true);
    expect(pullControl(renderer).props.refreshing).toBe(true);
    unmount();
  });

  it('forces one sync when the settings page reports its return', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    // Nothing pending: a foreground return on its own syncs nothing.
    state.appStateHandler?.('active');
    expect(state.resync).not.toHaveBeenCalled();

    button(renderer, 'Manage access')?.onPress?.();
    expect(state.openManageAccess).toHaveBeenCalledTimes(1);
    await waitFor(() => state.resync.mock.calls.length === 1);

    // Android then also reports the next foreground; the first signal consumed
    // the pending change, so this one must not sync again.
    state.appStateHandler?.('active');
    expect(state.resync).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('forces a sync on the foreground when the settings page never reports its dismissal', async () => {
    const pending = Promise.withResolvers<undefined>();
    state.openManageAccess = vi.fn(() => pending.promise);
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    button(renderer, 'Manage access')?.onPress?.();
    expect(state.resync).not.toHaveBeenCalled();

    state.appStateHandler?.('active');
    expect(state.resync).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(state.resync).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('refetches the Bitbucket workspace snapshot instead of forcing a provider read', async () => {
    state.platform = 'bitbucket';
    state.openManageAccess = undefined;
    state.readiness = {
      repositoryCache: {
        status: 'available',
        repositories: [{ id: 'uuid-1', fullName: 'acme/api', private: true }],
      },
    };
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    await waitFor(() => buttons(renderer).length > 0);

    expect(button(renderer, 'Manage access')).toBeUndefined();
    button(renderer, 'Refresh')?.onPress?.();
    expect(state.readinessRefetch).toHaveBeenCalledTimes(1);
    expect(state.resync).not.toHaveBeenCalled();
    unmount();
  });
});

// The repository selection this screen draws is unusable without the reviewer
// config, so a config read that failed -- or that stayed pending with nothing
// in flight -- must replace the disabled toggles with the action that resolves
// it, while the repositories query keeps its own error state.
describe('repository picker config read states', () => {
  it('shows the retryable error instead of disabled toggles when the load fails', async () => {
    state.config.data = null;
    state.config.isError = true;
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));

    await waitFor(() => state.queryErrorProps.length > 0);

    expect(state.queryErrorProps.at(-1)?.variant).toBe('server');
    expect(renderer.root.findAll(node => String(node.type) === 'RepoToggleRow')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    unmount();
  });

  it('retries the config read from the error state', async () => {
    state.config.data = null;
    state.config.isError = true;
    const { unmount } = await renderWithProviders(createElement(ReposRoute));

    await waitFor(() => state.queryErrorProps.length > 0);
    act(() => {
      state.queryErrorProps.at(-1)?.onRetry?.();
    });

    expect(state.config.refetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('names the confirmed-offline pause as the reason the load stopped', async () => {
    state.config.data = null;
    state.config.fetchStatus = 'paused';
    const { unmount } = await renderWithProviders(createElement(ReposRoute));

    await waitFor(() => state.queryErrorProps.length > 0);

    expect(state.queryErrorProps.at(-1)?.variant).toBe('offline');
    unmount();
  });

  it('keeps the repository rows when cached config backs a failed refetch', async () => {
    state.config.isError = true;
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));

    await waitFor(
      () => renderer.root.findAll(node => String(node.type) === 'RepoToggleRow').length === 2
    );

    expect(state.queryErrorProps).toHaveLength(0);
    unmount();
  });
});
