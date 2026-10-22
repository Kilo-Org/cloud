// The Bitbucket reviewer overview must paint one surface for its config read:
// rows from cache, an error with retry, or a loading state. A pending read that
// nothing is fetching (the state a cancelled first fetch reverts to) used to
// match none of the screen's separate tests, leaving the header over an empty
// scroll area.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

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
  fetchStatus: 'idle' as string,
}));

const connectivity = vi.hoisted(() => ({ known: true }));
const queryError = vi.hoisted(() => ({
  variants: [] as (string | undefined)[],
  retries: [] as (() => void)[],
}));
const skeletonRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', () => ({ View: 'View', Switch: 'Switch' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/agents/model-selector', () => ({ openModelPicker: vi.fn() }));
vi.mock('@/components/code-reviewer/bitbucket-connect-form', () => ({
  BitbucketConnectForm: () => null,
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
vi.mock('@/lib/integration-urls', () => ({ getBitbucketIntegrationUrl: () => 'https://x.test' }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  classifyProviderState: () => ({ status: 'connected' }),
  useBitbucketReadiness: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    fetchStatus: readiness.fetchStatus,
    data: { connected: readiness.connected, ready: readiness.ready, workspace: { slug: 'ws' } },
    refetch: vi.fn(),
  }),
  useSaveReviewConfig: () => ({ isPending: false, mutate: vi.fn() }),
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
  readiness.fetchStatus = 'idle';
  connectivity.known = true;
  queryError.variants = [];
  queryError.retries = [];
  skeletonRenders.count = 0;
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
