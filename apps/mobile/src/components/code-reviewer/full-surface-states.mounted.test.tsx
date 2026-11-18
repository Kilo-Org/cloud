/* eslint-disable max-lines -- cohesive mounted suite for the code-reviewer surface states */
import { createElement, type ReactElement, type ReactNode, type Ref } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import ReposRoute from '@/app/(app)/code-reviewer/[scope]/[platform]/(edit)/repos';
import { type ReviewerPlatform, type ReviewerScopePlatform } from '@/lib/code-reviewer-config';
import type * as ReviewerStatusModule from '@/lib/code-reviewer-status';
import { ReviewerRouteParamsProvider } from '@/lib/hooks/use-reviewer-route-params';
import { resetNowTickersForTests } from '@/lib/hooks/now-ticker-store';
import { parseTimestamp, timeAgo } from '@/lib/utils';
import { ReviewListScreen } from './review-list-screen';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

type ReviewStub = {
  id: string;
  pr_title: string;
  repo_full_name: string;
  pr_number: number;
  status: string;
  created_at: string;
};

function review(id: string, prTitle = `Review ${id}`): ReviewStub {
  return {
    id,
    pr_title: prTitle,
    repo_full_name: 'org/repo',
    pr_number: 1,
    status: 'completed',
    created_at: '2026-09-01T00:00:00Z',
  };
}

const state = vi.hoisted(() => ({
  insets: { left: 0, right: 0 },
  platform: 'gitlab',
  connected: false,
  githubError: false,
  githubStaleError: false,
  gitlabError: false,
  scope: 'personal',
  organizations: [] as {
    organizationId: string;
    organizationName: string;
    role?: string;
  }[],
  permissionOverride: null as
    | { status: 'loading' }
    | { status: 'ready'; canEdit: boolean; canManage: boolean }
    | null,
  repositories: {
    data: { repositories: [] } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  bitbucket: {
    data: {
      connected: false,
      repositoryCache: { status: 'available', repositories: [] },
    } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  reviews: {
    data: { pages: [{ success: true, reviews: [] }], pageParams: [0] } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    refetch: vi.fn(),
  },
  push: vi.fn(),
  handoffUrl: vi.fn(),
  openExternalUrl: vi.fn(),
  toastError: vi.fn(),
  resync: vi.fn(() => Promise.resolve()),
  toggleRepo: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: state.push }),
  useNavigation: () => ({ isFocused: () => true }),
  useFocusEffect: () => undefined,
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
  // The migrated rows draw their chevron through the directional icon, which
  // reads the RTL flag on every render.
  I18nManager: { isRTL: false },
  StatusBar: { currentHeight: 24 },
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844, scale: 3 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    bottom: 0,
    left: state.insets.left,
    right: state.insets.right,
  }),
}));
// The real list renders its rows; the stub keeps that, wrapping each one in a
// host node the suite can read, while the `FlashList` props stay inspectable for
// the list-contract assertions.
vi.mock('@shopify/flash-list', async () => {
  // `vi.mock` factories run before the file's imports bind, so React is loaded
  // here rather than from the top-level import.
  const {
    createElement: create,
    forwardRef,
    isValidElement,
    useImperativeHandle,
  } = await import('react');
  // The header and empty slots render as given, so a screen that moved its
  // controls into the list keeps them reachable from the mounted tree.
  const slot = (value: unknown) => (isValidElement(value) ? value : null);
  return {
    FlashList: forwardRef(function FlashListStub(
      props: {
        data?: unknown[];
        renderItem: (info: { item: never; index: number }) => ReactNode;
        ListHeaderComponent?: unknown;
        ListEmptyComponent?: unknown;
      },
      ref: Ref<unknown>
    ) {
      // The screen resets its offset when the query changes, so the stub keeps
      // the imperative surface the real list exposes.
      useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }), []);
      const data = props.data ?? [];
      return create(
        'FlashList',
        props,
        slot(props.ListHeaderComponent),
        data.map((item, index) =>
          create('ReviewRow', { key: index }, props.renderItem({ item: item as never, index }))
        ),
        data.length === 0 ? slot(props.ListEmptyComponent) : null
      );
    }),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('sonner-native', () => ({ toast: { error: state.toastError } }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/tab-screen', () => ({
  TAB_SCREEN_TRAILING_GAP: 16,
  TabScreenScrollView: 'TabScreenScrollView',
  useTabBarBottomPadding: () => 0,
  useTabScreenFrame: () => ({ frameStyle: {}, measureFrame: () => undefined }),
}));
vi.mock('@/components/ui/input', () => ({ Input: 'TextInput' }));
vi.mock('@/components/repo-toggle-row', () => ({ RepoToggleRow: 'RepoToggleRow' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/radio-group', () => ({ RadioGroup: 'RadioGroup' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
// The loading body is compared with the loaded rows, so the row primitive is a
// host node this suite reads by its own props.
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FolderGit2: 'FolderGit2',
  GitPullRequest: 'GitPullRequest',
  Search: 'Search',
  SearchX: 'SearchX',
  X: 'X',
  Settings: 'Settings',
  ArrowRight: 'ArrowRight',
  ShieldCheck: 'ShieldCheck',
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/app-shell-handoff', () => ({ appShellHandoffUrl: state.handoffUrl }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: state.openExternalUrl }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: (url: string) => state.openExternalUrl(url),
  reportLateLaunchFailure: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    personalReviewAgent: {
      listGitHubRepositories: {
        queryOptions: (input: unknown) => ({ queryKey: ['personal-github', input] }),
      },
      listGitLabRepositories: {
        queryOptions: (input: unknown) => ({ queryKey: ['personal-gitlab', input] }),
      },
    },
    organizations: {
      list: {
        queryOptions: () => ({
          queryKey: ['organizations', 'list'],
          queryFn: () => Promise.resolve(state.organizations),
        }),
      },
      reviewAgent: {
        listGitHubRepositories: {
          queryOptions: (input: unknown) => ({ queryKey: ['org-github', input] }),
        },
        listGitLabRepositories: {
          queryOptions: (input: unknown) => ({ queryKey: ['org-gitlab', input] }),
        },
      },
    },
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  isPersonal: (scope: string) => scope === 'personal',
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({
    data: state.githubError ? undefined : { connected: state.connected },
    isError: state.githubError || state.githubStaleError,
  }),
  useGitLabStatus: () => ({
    data: state.gitlabError ? undefined : { connected: false },
    isError: state.gitlabError,
  }),
  useReviewConfig: () => ({
    data: { repositorySelectionMode: 'selected', selectedRepositoryIds: [] },
  }),
  useSaveReviewConfig: () => ({ mutate: vi.fn() }),
  useGitHubRepositories: () => state.repositories,
  useGitLabRepositories: () => state.repositories,
  useBitbucketReadiness: () => state.bitbucket,
}));
vi.mock('@/lib/hooks/use-code-reviewer-repo-selection', () => ({
  useRepoSelectionToggle: () => state.toggleRepo,
}));
vi.mock('@/lib/hooks/use-bitbucket', () => ({
  // The Bitbucket setup recovery card reads this only for its own repair
  // action; these surface states never press it.
  useRefreshBitbucketRepositories: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/hooks/use-code-reviewer-repo-sync', () => ({
  useReviewerRepositoriesResync: () => ({ resync: state.resync, resyncing: false }),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({ useReviewList: () => state.reviews }));
// The screen reads the role from this module directly. The real hook is a thin
// react-query wrapper, so the mock answers from the same membership rows and the
// real classifier, and `permissionOverride` stands in for a read that has not
// settled — which the shared `organizations` answer can never produce.
vi.mock('@/lib/hooks/use-reviewer-permission', async () => {
  const { classifyPermission } = await vi.importActual<typeof ReviewerStatusModule>(
    '@/lib/code-reviewer-status'
  );
  return {
    useReviewerPermission: (scope: string) => {
      if (state.permissionOverride) {
        return state.permissionOverride;
      }
      return classifyPermission({
        isPersonal: scope === 'personal',
        isLoading: false,
        isError: false,
        isFetching: false,
        hasData: true,
        role: state.organizations.find(org => org.organizationId === scope)?.role,
        refetch: () => undefined,
      });
    },
  };
});
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/hooks/use-reviewer-council', () => ({
  useCouncilGate: () => ({ allowed: false, pending: false }),
  useCouncilUiEnabled: () => false,
}));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false }),
  modelLabelFromCatalogue: () => 'default model',
  thinkingEffortLabel: (effort: string) => effort,
}));
vi.mock('@/components/code-reviewer/repository-model-overrides', () => ({
  RepositoryModelOverrides: 'RepositoryModelOverrides',
}));
vi.mock('@/components/code-reviewer/review-memory-analyze-section', () => ({
  ReviewMemoryAnalyzeSection: 'ReviewMemoryAnalyzeSection',
}));

beforeEach(() => {
  state.insets.left = 0;
  state.insets.right = 0;
  state.platform = 'gitlab';
  state.connected = false;
  state.githubError = false;
  state.githubStaleError = false;
  state.gitlabError = false;
  state.scope = 'personal';
  state.organizations = [];
  state.permissionOverride = null;
  state.repositories.data = { repositories: [] };
  state.repositories.isError = false;
  state.bitbucket.data = {
    connected: false,
    repositoryCache: { status: 'available', repositories: [] },
  };
  state.bitbucket.isError = false;
  state.reviews.data = { pages: [{ success: true, reviews: [] }], pageParams: [0] };
  state.reviews.isError = false;
  state.reviews.isFetchingNextPage = false;
  state.reviews.isFetchNextPageError = false;
  state.reviews.hasNextPage = false;
  state.reviews.error.data.code = 'INTERNAL_SERVER_ERROR';
  state.handoffUrl.mockReset();
  state.openExternalUrl.mockReset();
  state.openExternalUrl.mockResolvedValue(undefined);
  state.toastError.mockReset();
  state.resync.mockClear();
  vi.clearAllMocks();
});

/** The `[platform]` layout validates the pair and publishes it to the screen. */
function reposRoute() {
  // Bitbucket is org-only, so a personal+bitbucket pair is not one the layout
  // could accept; those cases run under an organization scope instead.
  const platform = state.platform as ReviewerPlatform;
  const personal = state.scope === 'personal' && platform !== 'bitbucket';
  const params: ReviewerScopePlatform = personal
    ? { kind: 'personal', platform: platform as 'github' | 'gitlab' }
    : {
        kind: 'org',
        organizationId: state.scope === 'personal' ? 'org-1' : state.scope,
        platform,
      };
  return (
    <ReviewerRouteParamsProvider params={params}>
      <ReposRoute />
    </ReviewerRouteParamsProvider>
  );
}

function firstList(renderer: Awaited<ReturnType<typeof renderWithProviders>>['renderer']) {
  return renderer.root.find(node => String(node.type) === 'FlashList');
}

/** Every string a React element tree renders, in order. */
function elementTexts(node: unknown): string[] {
  if (node == null || typeof node === 'boolean') {
    return [];
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(child => elementTexts(child));
  }
  if (typeof node === 'object' && 'props' in node) {
    const props = node.props;
    if (typeof props === 'object' && props !== null && 'children' in props) {
      return elementTexts(props.children);
    }
  }
  return [];
}

/**
 * The relative time the first row paints, read from the row the list rendered.
 * Nothing here rebuilds the row: a row element is created inside the screen's
 * own render, so re-reading the tree is exactly what a person sees when the
 * data behind the list has not changed.
 */
function firstRowAge(renderer: Awaited<ReturnType<typeof renderWithProviders>>['renderer']) {
  const row = renderer.root.findAll(node => String(node.type) === 'ReviewRow')[0];
  if (row === undefined) {
    throw new Error('The list rendered no review row.');
  }
  const age = elementTexts(row.props.children).at(-1);
  if (age === undefined) {
    throw new Error('The review row rendered no relative time.');
  }
  return age;
}

/** The GitHub empty state's action button, typed enough for oxlint. */
function pressManageAccess(renderer: RenderWithProvidersResult['renderer']) {
  const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
  const action = empty.props.action as { props: { onPress: () => void } };
  action.props.onPress();
}

/** The rows the list is drawing, in list order. */
function rows(renderer: RenderWithProvidersResult['renderer']) {
  return firstList(renderer).findAll(node => String(node.type) === 'RepoToggleRow');
}

/** The full names of the rows on screen, in list order. */
function rowNames(renderer: RenderWithProvidersResult['renderer']): string[] {
  return rows(renderer).map(row => {
    // The row stub is a host node, so the test renderer exposes its props
    // untyped; this suite's own mock defines the shape.
    const { repo } = row.props as { repo: { fullName: string } };
    return repo.fullName;
  });
}

/** Types into the query field the way the native field reports it. */
function typeQuery(renderer: RenderWithProvidersResult['renderer'], query: string) {
  const input = renderer.root.findByType('TextInput');
  act(() => {
    (input.props.onChangeText as (text: string) => void)(query);
  });
}

describe('Reviewer repository bodies', () => {
  it.each(['gitlab', 'bitbucket'])(
    'centers the %s empty body outside its scroller',
    async platform => {
      state.platform = platform;
      const { renderer, unmount } = await renderWithProviders(reposRoute());
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      expect(renderer.root.find(node => String(node.type) === 'EmptyState').props.placement).toBe(
        'center'
      );
      unmount();
    }
  );

  it('keeps the GitHub empty state beside its selection controls', async () => {
    state.platform = 'github';
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    const list = firstList(renderer);
    expect(list.find(node => String(node.type) === 'RadioGroup')).toBeDefined();
    expect(list.find(node => String(node.type) === 'EmptyState').props.placement).toBe('top');
    unmount();
  });

  it('opens the app shell hand-off for the GitHub settings page', async () => {
    state.platform = 'github';
    state.handoffUrl.mockResolvedValue('https://example.test/app-shell/handoff?token=handoff-1');
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    pressManageAccess(renderer);
    await vi.waitFor(() => {
      expect(state.openExternalUrl).toHaveBeenCalledWith(
        'https://example.test/app-shell/handoff?token=handoff-1'
      );
    });
    expect(state.handoffUrl).toHaveBeenCalledWith({ page: 'github-app' });
    expect(state.toastError).not.toHaveBeenCalled();
    unmount();
  });

  it('names the organization on the hand-off target', async () => {
    state.platform = 'github';
    state.scope = 'org-1';
    state.handoffUrl.mockResolvedValue('https://example.test/app-shell/handoff?token=handoff-1');
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    pressManageAccess(renderer);
    await vi.waitFor(() => {
      expect(state.handoffUrl).toHaveBeenCalledWith({
        page: 'github-app',
        organizationId: 'org-1',
      });
    });
    unmount();
  });

  it('toasts without opening anything when the hand-off cannot be minted', async () => {
    state.platform = 'github';
    state.handoffUrl.mockRejectedValue(
      Object.assign(new Error('offline'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    pressManageAccess(renderer);
    await vi.waitFor(() => {
      expect(state.toastError).toHaveBeenCalledWith('Could not open GitHub App settings');
    });
    expect(state.openExternalUrl).not.toHaveBeenCalled();
    unmount();
  });

  it('centers missing Bitbucket setup', async () => {
    state.platform = 'bitbucket';
    state.bitbucket.data = { repositoryCache: { status: 'unavailable' } };
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'CenteredState')).toBeDefined();
    unmount();
  });

  it('keeps cached repositories beside a partial error', async () => {
    state.repositories.isError = true;
    state.repositories.data = { repositories: [{ id: 1, fullName: 'org/repo', private: false }] };
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    const list = firstList(renderer);
    expect(list.find(node => String(node.type) === 'RepoToggleRow')).toBeDefined();
    expect(list.find(node => String(node.type) === 'QueryError').props.placement).toBe('top');
    unmount();
  });
});

// A snapshot long enough to scroll is only usable if the reader can narrow it.
// The rows come from the query; a row the query hides keeps its place in the
// stored selection, so clearing the query brings every row back.
describe('repository search', () => {
  const REPOSITORIES = [
    { id: 1, fullName: 'kilo-org/cloud', private: false },
    { id: 2, fullName: 'kilo-org/cloud-tools', private: true },
    { id: 3, fullName: 'other-lab/website', private: false },
  ];
  const ALL_NAMES = REPOSITORIES.map(repository => repository.fullName);

  beforeEach(() => {
    state.platform = 'github';
    state.repositories.data = { repositories: REPOSITORIES };
  });

  it('narrows the rows to a case-insensitive name fragment and restores them on clear', async () => {
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    expect(rowNames(renderer)).toEqual(ALL_NAMES);

    typeQuery(renderer, 'CLOUD');
    expect(rowNames(renderer)).toEqual(['kilo-org/cloud', 'kilo-org/cloud-tools']);

    typeQuery(renderer, '');
    expect(rowNames(renderer)).toEqual(ALL_NAMES);
    unmount();
  });

  it('reports a toggle on a filtered row with that row id', async () => {
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    typeQuery(renderer, 'website');
    const row = rows(renderer)[0];
    if (!row) {
      throw new Error('the filtered row was not rendered');
    }
    const { onPress } = row.props as { onPress: () => void };
    act(() => {
      onPress();
    });
    expect(state.toggleRepo).toHaveBeenCalledWith(3);
    unmount();
  });

  it('shows the empty result state when nothing matches', async () => {
    const { renderer, unmount } = await renderWithProviders(reposRoute());
    typeQuery(renderer, 'missing');
    expect(rows(renderer)).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'EmptyState').props.title).toBe(
      'No matches'
    );
    unmount();
  });
});

describe('Recent review bodies', () => {
  it.each([
    { orientation: 'portrait', left: 0, right: 0 },
    { orientation: 'landscape', left: 47, right: 59 },
  ])(
    'keeps the $orientation list inside the side insets, with rows drawing the gutter',
    async ({ left, right }) => {
      state.insets.left = left;
      state.insets.right = right;
      state.reviews.data = {
        pages: [{ success: true, reviews: [review('r1'), review('r2')] }],
        pageParams: [0],
      };
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );
      // The container carries exactly the safe-area side insets, so a landscape
      // row never starts under the sensor housing; the page gutter and the top
      // space belong to the row, which every recycled row draws identically.
      expect(firstList(renderer).props.contentContainerStyle).toEqual({
        paddingLeft: left,
        paddingRight: right,
      });
      const reviewRows = renderer.root.findAll(node => String(node.type) === 'ReviewRow');
      expect(reviewRows.length).toBeGreaterThan(0);
      for (const row of reviewRows) {
        const pressable = row.find(node => Object.is(node.type, 'Pressable'));
        const classes = String(pressable.props.className ?? '').split(' ');
        expect(classes).toContain('px-4');
        expect(classes).toContain('py-3');
      }
      unmount();
    }
  );

  it.each([false, true])(
    'keeps the correct empty action with provider connection %s',
    async connected => {
      state.connected = connected;
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );
      const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
      expect(empty.props.placement).toBeUndefined();
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      const action = empty.props.action as ReactElement<{ onPress: () => void }>;
      action.props.onPress();
      expect(state.push).toHaveBeenCalledWith(
        `/(app)/code-reviewer/personal${connected ? '/manual-review' : ''}`
      );
      unmount();
    }
  );

  it.each([false, true])(
    'opens the empty action destination once on a fast double tap, connected %s',
    async connected => {
      state.connected = connected;
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );
      const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
      const action = empty.props.action as ReactElement<{ onPress: () => void }>;
      action.props.onPress();
      action.props.onPress();

      expect(state.push).toHaveBeenCalledTimes(1);
      expect(state.push).toHaveBeenCalledWith(
        `/(app)/code-reviewer/personal${connected ? '/manual-review' : ''}`
      );
      unmount();
    }
  );

  it.each(['INTERNAL_SERVER_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'])(
    'keeps the %s retry policy outside the scroller',
    async code => {
      state.reviews.data = undefined;
      state.reviews.isError = true;
      state.reviews.error.data.code = code;
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );
      const error = renderer.root.find(node => String(node.type) === 'QueryError');
      expect(error.props.placement).toBeUndefined();
      expect(Boolean(error.props.onRetry)).toBe(code === 'INTERNAL_SERVER_ERROR');
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      unmount();
    }
  );

  it('keeps cached reviews after a background failure', async () => {
    state.reviews.isError = true;
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1', 'Saved review')] }],
      pageParams: [0],
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = firstList(renderer);
    expect(list.props.data).toEqual([review('r1', 'Saved review')]);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    unmount();
  });

  it('dedupes reviews across pages, keeping first occurrence order', async () => {
    state.reviews.data = {
      pages: [
        { success: true, reviews: [review('r1'), review('r2')] },
        { success: true, reviews: [review('r2'), review('r3')] },
      ],
      pageParams: [0, 2],
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = firstList(renderer);
    const data = list.props.data as ReviewStub[];
    expect(data.map(item => item.id)).toEqual(['r1', 'r2', 'r3']);
    unmount();
  });

  it('fetches the next page on end reached only when idle with more pages', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.hasNextPage = true;
    state.reviews.isFetchingNextPage = false;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const onEndReached = firstList(renderer).props.onEndReached as () => void;
    onEndReached();
    expect(state.reviews.fetchNextPage).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not fetch the next page while one is already in flight', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.hasNextPage = true;
    state.reviews.isFetchingNextPage = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const onEndReached = firstList(renderer).props.onEndReached as () => void;
    onEndReached();
    expect(state.reviews.fetchNextPage).not.toHaveBeenCalled();
    unmount();
  });

  it('shows one footer row skeleton while the next page loads', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.hasNextPage = true;
    state.reviews.isFetchingNextPage = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const footer = firstList(renderer).props.ListFooterComponent as ReactNode;
    unmount();
    const footerRender = await renderWithProviders(createElement('Footer', null, footer));
    // The footer's placeholder is the row primitive's own two-line shape, so it
    // hands over to the next page's rows without moving them.
    const placeholders = footerRender.renderer.root.findAll(
      node => String(node.type) === 'RowSkeleton'
    );
    expect(placeholders).toHaveLength(1);
    const [placeholder] = placeholders;
    expect(placeholder?.props.lines).toBe(3);
    footerRender.unmount();
  });

  it('keeps the list and an inline retry when the next page fails, without auto-retrying', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.isFetchNextPageError = true;
    state.reviews.hasNextPage = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = firstList(renderer);
    const data = list.props.data as ReviewStub[];
    expect(data.map(item => item.id)).toEqual(['r1']);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    const footer = list.props.ListFooterComponent as ReactNode;
    // A failed next page must not auto-refire: the footer flickers skeleton/error and hides Retry.
    (list.props.onEndReached as () => void)();
    expect(state.reviews.fetchNextPage).not.toHaveBeenCalled();
    unmount();
    const footerRender = await renderWithProviders(createElement('Footer', null, footer));
    const error = footerRender.renderer.root.find(node => String(node.type) === 'QueryError');
    expect(error.props.placement).toBe('top');
    const onRetry = error.props.onRetry as () => void;
    onRetry();
    expect(state.reviews.fetchNextPage).toHaveBeenCalledTimes(1);
    footerRender.unmount();
  });

  it('advances a row relative time without new data, from the shared clock', async () => {
    // The page-one probe keeps refetching while a review is in flight, and its
    // rows come back unchanged, so the row element is never rebuilt with a new
    // label. The relative time must therefore follow the clock by itself.
    vi.useFakeTimers();
    resetNowTickersForTests();
    try {
      vi.setSystemTime(new Date('2026-09-01T00:36:00.000Z').getTime());
      const startedAt = '2026-09-01T00:18:00.000Z';
      state.reviews.data = {
        pages: [
          {
            success: true,
            reviews: [
              {
                ...review('running'),
                status: 'running',
                created_at: '2026-09-01T00:16:00.000Z',
                started_at: startedAt,
                completed_at: null,
              },
            ],
          },
        ],
        pageParams: [0],
      };
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );

      expect(firstRowAge(renderer)).toBe('18 minutes ago');
      expect(firstRowAge(renderer)).toBe(timeAgo(parseTimestamp(startedAt)));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Same row object, same rendered tree shape: only the clock moved.
      expect(firstRowAge(renderer)).toBe('19 minutes ago');
      expect(firstRowAge(renderer)).toBe(timeAgo(parseTimestamp(startedAt)));

      act(() => {
        unmount();
      });
    } finally {
      resetNowTickersForTests();
      vi.useRealTimers();
    }
  });
});

// A reader who belongs to several organizations must be able to tell whose
// reviews are listed, the way the platform list for the same scope already
// names them.
describe('Recent review header', () => {
  it('names the organization scope that owns the listed reviews', async () => {
    state.organizations = [{ organizationId: 'org-1', organizationName: 'Drain Labs' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'org-1' })
    );
    const findHeader = () => renderer.root.find(node => String(node.type) === 'ScreenHeader');
    await waitFor(() => findHeader().props.title === 'Drain Labs');

    expect(findHeader().props.eyebrow).toBe('Recent reviews');
    // The scope name is prose, but the header paints it on the one line the
    // personal scope uses: a second line reserved for it made this header
    // taller than the Personal one, pushing the eyebrow down and opening a
    // wider gap above the first review. One line needs no reserved blank line —
    // a name that arrives later still paints on that same line — so the header
    // keeps the personal header's height instead of outgrowing it.
    expect(findHeader().props.titleNumberOfLines).toBe(1);
    expect(findHeader().props.reserveTitleSpace).toBe(false);
    unmount();
  });

  it('names the personal scope, on the single line it always fills', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );

    const node = renderer.root.find(candidate => String(candidate.type) === 'ScreenHeader');
    expect(node.props.title).toBe('Personal');
    expect(node.props.eyebrow).toBe('Recent reviews');
    expect(node.props.titleNumberOfLines).toBe(1);
    expect(node.props.reserveTitleSpace).toBe(false);
    unmount();
  });
});

// The empty list's Configure button opens the platform list, and each platform's
// connect card there is per-role: GitHub's needs an organization-manage role,
// GitLab's a billing-level edit role. A plain member would land on a screen with
// no action of their own, so the scope-level screen replaces the button with a
// role notice — while a connected scope keeps the manual-review destination for
// every role.
describe('empty reviews connect action', () => {
  const SCOPE = 'org-1';
  const ORG_NAME = 'Drain Labs';

  function emptyState(renderer: RenderWithProvidersResult['renderer']) {
    return renderer.root.find(node => String(node.type) === 'EmptyState');
  }

  /**
   * The scope title paints from the same `organizations.list` read the role
   * comes from, so reading the name means the role has settled too.
   */
  async function settled(renderer: RenderWithProvidersResult['renderer']) {
    await waitFor(
      () =>
        String(renderer.root.find(node => String(node.type) === 'ScreenHeader').props.title) ===
        ORG_NAME
    );
  }

  function pressAction(renderer: RenderWithProvidersResult['renderer']) {
    const action = emptyState(renderer).props.action as ReactElement<{ onPress: () => void }>;
    action.props.onPress();
  }

  function actionLabel(renderer: RenderWithProvidersResult['renderer']) {
    const action = emptyState(renderer).props.action as ReactElement<{ label: string }>;
    return action.props.label;
  }

  it('replaces the button with a role notice for a plain member', async () => {
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'member' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    const empty = emptyState(renderer);
    expect(empty.props.action).toBeUndefined();
    expect(empty.props.description).toBe(i18n.t('codeReviewer.reviewList.connectOwnerOnly'));
    unmount();
  });

  it('keeps the neutral explanation when only Bitbucket is connected', async () => {
    // Bitbucket runs automatic reviews but offers no manual review, so a member
    // cannot act here either; the notice would be false, because the scope is
    // connected, and an owner would find it already set up.
    state.bitbucket.data = {
      connected: true,
      repositoryCache: { status: 'available', repositories: [] },
    };
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'member' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    const empty = emptyState(renderer);
    expect(empty.props.action).toBeUndefined();
    expect(empty.props.description).toBe(i18n.t('codeReviewer.reviewList.noReviewsDescription'));
    unmount();
  });

  it('keeps the neutral explanation when the provider read failed', async () => {
    // A failed status read leaves the connection unknown, so the notice would
    // claim the scope has nothing connected when the screen cannot know that.
    state.githubError = true;
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'member' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    const empty = emptyState(renderer);
    expect(empty.props.action).toBeUndefined();
    expect(empty.props.description).toBe(i18n.t('codeReviewer.reviewList.noReviewsDescription'));
    unmount();
  });

  it('keeps the role notice when a refetch failed over a cached disconnected answer', async () => {
    // `isError` stays true for a failed background refetch, but the cached
    // answer still says nothing is connected, so the notice is accurate.
    state.githubStaleError = true;
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'member' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    const empty = emptyState(renderer);
    expect(empty.props.action).toBeUndefined();
    expect(empty.props.description).toBe(i18n.t('codeReviewer.reviewList.connectOwnerOnly'));
    unmount();
  });

  it('offers the platform list to an owner', async () => {
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'owner' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    const empty = emptyState(renderer);
    expect(empty.props.description).toBe(i18n.t('codeReviewer.reviewList.noReviewsDescription'));
    expect(empty.props.action).toBeDefined();
    pressAction(renderer);
    expect(state.push).toHaveBeenCalledWith(`/(app)/code-reviewer/${SCOPE}`);
    unmount();
  });

  it('offers the platform list to a billing manager, who can connect GitLab', async () => {
    state.organizations = [
      { organizationId: SCOPE, organizationName: ORG_NAME, role: 'billing_manager' },
    ];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    const empty = emptyState(renderer);
    expect(empty.props.description).toBe(i18n.t('codeReviewer.reviewList.noReviewsDescription'));
    expect(empty.props.action).toBeDefined();
    unmount();
  });

  it('keeps the loading body until the role settles, so no button flashes', async () => {
    state.permissionOverride = { status: 'loading' };
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'member' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    // The loading body reserves the loaded overview's geometry: the same number
    // of two-line rows, so swapping in the real data never changes the height.
    const loadingRows = renderer.root.findAll(node => String(node.type) === 'RowSkeleton');
    expect(loadingRows.length).toBeGreaterThan(0);
    expect(loadingRows.every(row => row.props.lines === 3)).toBe(true);
    unmount();

    state.permissionOverride = null;
    state.reviews.data = {
      pages: [
        {
          success: true,
          reviews: [review('r1'), review('r2'), review('r3')],
        },
      ],
      pageParams: [0],
    };
    const loaded = await renderWithProviders(createElement(ReviewListScreen, { scope: SCOPE }));
    await settled(loaded.renderer);
    expect(loaded.renderer.root.findAll(node => String(node.type) === 'ReviewRow')).toHaveLength(
      loadingRows.length
    );
    loaded.unmount();
  });

  it('keeps the manual-review action for a member once a provider is connected', async () => {
    state.connected = true;
    state.organizations = [{ organizationId: SCOPE, organizationName: ORG_NAME, role: 'member' }];
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: SCOPE })
    );
    await settled(renderer);

    expect(actionLabel(renderer)).toBe(i18n.t('codeReviewer.reviewList.startManualReview'));
    pressAction(renderer);
    expect(state.push).toHaveBeenCalledWith(`/(app)/code-reviewer/${SCOPE}/manual-review`);
    unmount();
  });
});
