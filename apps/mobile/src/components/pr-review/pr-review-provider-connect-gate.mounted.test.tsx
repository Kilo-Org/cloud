import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { PrReviewConnectGate } from './pr-review-connect-gate';

// Mutable so each test publishes the provider scope the layout would carry.
const scopeState = vi.hoisted(() => ({
  value: null as { ref: unknown } | null,
}));
vi.mock('@/lib/pr-review/provider-pr-ref', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useProviderPrScopeOrNull: () => scopeState.value,
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { connected: false, revoked: false },
    isPending: false,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutateAsync: vi.fn(), isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: { queryOptions: () => ({}), queryKey: () => [] },
      connectUserAuthorization: { mutationOptions: () => ({}) },
    },
    organizations: {
      reviewAgent: {
        getGitLabStatus: { queryOptions: () => ({}) },
        getBitbucketReadiness: { queryOptions: () => ({}) },
      },
    },
    personalReviewAgent: { getGitLabStatus: { queryOptions: () => ({}) } },
  }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.example' }));
vi.mock('expo-router', () => ({ usePathname: () => '/pr-review/gitlab/group/repo/3' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { OPENED: 'opened', DISMISS: 'dismiss', CANCEL: 'cancel' },
}));
vi.mock('@/components/ui/icons', () => ({
  PlugZap: 'PlugZap',
  RefreshCcw: 'RefreshCcw',
  ShieldAlert: 'ShieldAlert',
}));
vi.mock('@/components/icons/github-icon', () => ({ GitHubIcon: 'GitHubIcon' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { description?: React.ReactNode; action?: React.ReactNode }) =>
    React.createElement('EmptyState', props, props.description, props.action),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/pr-review/pr-review-context-line', () => ({
  PrReviewContextLine: 'PrReviewContextLine',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn() },
  Platform: { OS: 'android' },
  View: 'View',
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(platform: 'gitlab' | 'bitbucket') {
  act(() => {
    mounted = TestRenderer.create(
      <PrReviewConnectGate platform={platform} organizationId={null}>
        {React.createElement('ReviewContent')}
      </PrReviewConnectGate>
    );
  });
  if (!mounted) {
    throw new Error('gate did not mount');
  }
  return mounted;
}

beforeEach(() => {
  vi.resetAllMocks();
  scopeState.value = null;
});

describe('provider gate instance hint', () => {
  it('passes a self-managed GitLab instance hint to the context line', () => {
    scopeState.value = {
      ref: {
        platform: 'gitlab',
        projectPath: 'group/repo',
        mrIid: 3,
        instanceHint: 'https://gitlab.example.com',
      },
    };
    const renderer = mount('gitlab');
    expect(renderer.root.findByType('PrReviewContextLine').props.instanceHint).toBe(
      'https://gitlab.example.com'
    );
  });

  it('passes no instance hint for gitlab.com or a missing hint', () => {
    scopeState.value = {
      ref: {
        platform: 'gitlab',
        projectPath: 'group/repo',
        mrIid: 3,
        instanceHint: 'https://gitlab.com',
      },
    };
    const hinted = mount('gitlab');
    expect(hinted.root.findByType('PrReviewContextLine').props.instanceHint).toBeUndefined();

    scopeState.value = { ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 3 } };
    const bare = mount('gitlab');
    expect(bare.root.findByType('PrReviewContextLine').props.instanceHint).toBeUndefined();
  });
});
