// The Bitbucket reviewer overview must paint one surface for its config read:
// rows from cache, an error with retry, or a loading state. A pending read that
// nothing is fetching (the state a cancelled first fetch reverts to) used to
// match none of the screen's separate tests, leaving the header over an empty
// scroll area.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { BitbucketOverview } from './bitbucket-overview';

const config = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as string,
  data: null as unknown,
  refetch: vi.fn(),
}));

const readiness = vi.hoisted(() => ({
  connected: true,
  ready: true as boolean | undefined,
  integrationId: 'bitbucket-1' as string | null,
  workspaceSlug: 'ws' as string | undefined,
  fetchStatus: 'idle' as string,
}));

/** The integration-status read the OAuth verdict comes from. */
const status = vi.hoisted(() => ({
  // undefined data = the read is off (no request configured); `null` is not
  // expressible on this union, so the off state starts as missing.
  data: undefined as Record<string, unknown> | undefined,
  isPending: false,
  isError: false,
  error: undefined as unknown,
  refetch: vi.fn(),
}));

const connectivity = vi.hoisted(() => ({ known: true }));
const queryError = vi.hoisted(() => ({
  variants: [] as (string | undefined)[],
  retries: [] as (() => void)[],
}));
const skeletonRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
  View: 'View',
  Switch: 'Switch',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: (ms: number) => ({ fadeIn: ms }) },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
const motion = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: motion.reducedMotion,
    scrollAnimated: !motion.reducedMotion,
  }),
  selectReducedMotionEntrance: <T,>(reducedMotion: boolean, entrance: T) =>
    reducedMotion ? undefined : entrance,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: () => undefined,
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/components/code-reviewer/bitbucket-setup-recovery', () => ({
  BitbucketSetupRecovery: () => null,
}));
vi.mock('@/components/code-reviewer/platform-overview-rows', () => ({
  buildOverviewRows: () => [],
  resolveRowOnPress: () => undefined,
}));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children?: unknown }) => props.children,
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: { variant?: string; onRetry?: () => void }) => {
    queryError.variants.push(props.variant);
    if (props.onRetry) {
      queryError.retries.push(props.onRetry);
    }
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: () => null }));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => {
    skeletonRenders.count += 1;
    return null;
  },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.test' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  classifyProviderState: () => ({ status: 'connected' }),
  useBitbucketReadiness: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    isPending: false,
    fetchStatus: readiness.fetchStatus,
    data: {
      connected: readiness.connected,
      ready: readiness.ready,
      integrationId: readiness.integrationId,
      workspace: { slug: readiness.workspaceSlug },
      missingRequiredScopes: [],
      repositoryCache: {
        status: readiness.ready ? 'available' : 'uninitialized',
        repositories: [],
        syncedAt: null,
      },
      canManage: true,
      canTriggerManualReview: false,
    },
    refetch: vi.fn(),
  }),
  useSaveReviewConfig: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-bitbucket', () => ({
  useBitbucketIntegrationStatus: () => ({
    isLoading: false,
    isPending: status.isPending,
    isError: status.isError,
    isFetching: false,
    data: status.data,
    error: status.error,
    refetch: status.refetch,
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => (connectivity.known ? 'offline' : 'unknown'),
}));
vi.mock('@/lib/hooks/use-reviewer-models', () => ({
  useReviewerModels: () => ({ models: [], isLoading: false }),
}));

function makeConfig(over: Record<string, unknown> = {}) {
  return {
    isEnabled: true,
    reviewStyle: 'balanced',
    focusAreas: [],
    customInstructions: null,
    modelSlug: 'model',
    thinkingEffort: null,
    gateThreshold: 'off',
    repositorySelectionMode: 'all',
    selectedRepositoryIds: [],
    repositoryModelOverrides: [],
    disableReviewMd: false,
    actionRequired: null,
    ...over,
  };
}

async function renderScreen() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  // The screen takes live query results; the harness supplies only the fields
  // its body reads, cast once at this boundary.
  const props = {
    scope: 'org_1',
    config,
    toggle: { isPending: false, mutate: vi.fn() },
    canEdit: true,
    permissionLoading: false,
  } as unknown as Parameters<typeof BitbucketOverview>[0];
  await act(async () => {
    ref.current = TestRenderer.create(createElement(BitbucketOverview, props));
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

beforeEach(() => {
  config.isLoading = false;
  config.isError = false;
  config.isFetching = false;
  config.fetchStatus = 'idle';
  config.data = null;
  config.refetch.mockReset();
  readiness.connected = true;
  readiness.ready = true;
  readiness.workspaceSlug = 'ws';
  readiness.fetchStatus = 'idle';
  // Default the status read to the token-connection shape its own suite
  // concerns; the OAuth cases replace this object.
  status.data = { method: 'workspace_access_token', status: 'connected' };
  status.isPending = false;
  status.isError = false;
  status.error = undefined;
  status.refetch.mockReset();
  connectivity.known = true;
  queryError.variants = [];
  queryError.retries = [];
  skeletonRenders.count = 0;
  motion.reducedMotion = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BitbucketOverview config body', () => {
  it('keeps the skeleton while the first read is pending and idle', async () => {
    await renderScreen();

    expect(skeletonRenders.count).toBeGreaterThan(0);
    expect(queryError.variants).toEqual([]);
  });

  it('restarts an idle read once and then offers Retry', async () => {
    vi.useFakeTimers();
    config.refetch.mockImplementation(() => Promise.resolve());

    await renderScreen();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
    expect(queryError.variants).toEqual(['server']);
    expect(queryError.retries).toHaveLength(1);
  });

  it('keeps cached rows through a failed background refetch', async () => {
    config.data = makeConfig();
    config.isError = true;

    await renderScreen();

    expect(queryError.variants).toEqual([]);
    expect(skeletonRenders.count).toBe(0);
  });

  it('shows the offline error when the read is paused with known connectivity', async () => {
    config.fetchStatus = 'paused';

    await renderScreen();

    expect(queryError.variants).toEqual(['offline']);
  });
});

describe('BitbucketOverview Automatic reviews workspace line', () => {
  /** The muted line painted under the Automatic reviews label, when present. */
  function accountLines(renderer: TestRenderer.ReactTestRenderer): unknown[] {
    return renderer.root
      .findAllByType('Text')
      .filter(node => node.props.variant === 'muted')
      .map(node => node.props.children);
  }

  it('paints the connected workspace under the label', async () => {
    config.data = makeConfig();

    const renderer = await renderScreen();

    expect(accountLines(renderer)).toEqual(['ws']);
  });

  it('paints the label alone so the row keeps one line without a workspace slug', async () => {
    // An empty line here made the card taller than the sibling Follow REVIEW.md
    // row and lifted the label above the switch's centre.
    readiness.workspaceSlug = undefined;
    config.data = makeConfig();

    const renderer = await renderScreen();

    expect(accountLines(renderer)).toEqual([]);
  });
});

describe('BitbucketOverview rows entrance', () => {
  /** The animated container that holds every configuration row. */
  function rowsContainer(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root
      .findAllByType('Animated.View')
      .find(node => node.props.className === 'gap-6');
  }

  it('paints the rows without an entrance animation under reduced motion', async () => {
    // An entrance that never runs leaves the container at its initial opacity,
    // so the rows exist but paint nothing and the body stays empty until the
    // screen remounts.
    motion.reducedMotion = true;
    config.data = makeConfig();

    const renderer = await renderScreen();

    expect(rowsContainer(renderer)?.props.entering).toBeUndefined();
  });

  it('keeps the crossfade entrance while motion is allowed', async () => {
    motion.reducedMotion = false;
    config.data = makeConfig();

    const renderer = await renderScreen();

    expect(rowsContainer(renderer)?.props.entering).toBeDefined();
  });
});

// An organization connected through Bitbucket OAuth owns one read-only card:
// the web page ran the consent, so this surface offers no connect action and
// no editable rows.
describe('BitbucketOverview OAuth connection', () => {
  function oauthStatus(over: Record<string, unknown> = {}) {
    return {
      method: 'oauth',
      status: 'connected',
      integrationId: 'oauth-1',
      integrationStatus: 'active',
      recoveryAction: null,
      workspace: { uuid: 'ws-uuid', slug: 'acme', displayName: 'Acme Ltd' },
      authorizingNickname: 'acme-authorizer',
      invalidatedAt: null,
      invalidationReason: null,
      expiresAt: null,
      lastValidatedAt: null,
      repositoryCache: { status: 'available', repositories: [], syncedAt: null },
      canManage: true,
      ...over,
    };
  }

  function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .filter((child): child is string => typeof child === 'string');
  }

  it('renders the managed-on-web card without a Connect action or rows', async () => {
    // The readiness read reports the OAuth organization as not connected; the
    // status read is what names the connection.
    readiness.connected = false;
    readiness.integrationId = null;
    status.data = oauthStatus();

    const renderer = await renderScreen();

    expect(texts(renderer)).toContain(i18n.t('codeReviewer.bitbucketConnect.managedOnWeb'));
    expect(texts(renderer)).toContain('Acme Ltd');
    expect(renderer.root.findAllByType('Switch')).toHaveLength(0);
    expect(renderer.root.findAllByType('ConfigureRow')).toHaveLength(0);
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
  });

  it('renders the same read-only card when the OAuth authorization needs attention', async () => {
    for (const oauthState of ['workspace_selection_required', 'reconnect_required'] as const) {
      readiness.connected = false;
      readiness.integrationId = null;
      status.data = oauthStatus({ status: oauthState, workspace: null });

      const renderer = await renderScreen();

      expect(texts(renderer)).toContain(i18n.t('codeReviewer.bitbucketConnect.managedOnWeb'));
      expect(renderer.root.findAllByType('Button')).toHaveLength(0);
      expect(renderer.root.findAllByType('ConfigureRow')).toHaveLength(0);
    }
  });

  it('still paints the editable surface for a token connection', async () => {
    config.data = makeConfig();

    const renderer = await renderScreen();

    expect(renderer.root.findAllByType('Switch')).toHaveLength(1);
  });

  it('paints the QueryError when the readiness read failed with no data', async () => {
    readiness.connected = false;
    status.data = undefined;
    status.isPending = true;
    status.isError = true;
    status.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    await renderScreen();

    expect(queryError.variants).toEqual(['server']);
    expect(queryError.retries).toHaveLength(1);
  });
});
