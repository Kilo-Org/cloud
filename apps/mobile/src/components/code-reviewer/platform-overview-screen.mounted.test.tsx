/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// actionRequired banner contract: a non-null `actionRequired` on the reviewer
// config renders a distinct banner (title + description + recovery label)
// above the enable switch. Null renders no banner — including the
// disabled-without-blocker state, which must show the normal disabled copy,
// not a banner. This is neither the empty state nor a success check.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CODE_REVIEW_ACTION_REQUIRED_REASONS } from '@kilocode/app-shared/code-reviews';

import { PlatformOverviewScreen } from './platform-overview-screen';

const config = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  isFetching: false,
  data: null as unknown,
  refetch: vi.fn(),
}));

const permission = vi.hoisted(() => ({
  status: 'ready',
  canEdit: true,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'Switch',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('@/components/agents/model-selector', () => ({
  openModelPicker: vi.fn(),
}));
vi.mock('@/components/code-reviewer/bitbucket-overview', () => ({
  BitbucketOverview: () => null,
}));
vi.mock('@/components/code-reviewer/platform-overview-rows', () => ({
  buildOverviewRows: () => [],
  resolveRowOnPress: () => undefined,
}));
vi.mock('@/components/code-reviewer/provider-connect-card', () => ({
  ProviderConnectCard: () => null,
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: () => null,
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: () => null,
}));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: () => null }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: {
    github: { label: 'GitHub', reviewMd: true },
    gitlab: { label: 'GitLab', reviewMd: true },
    bitbucket: { label: 'Bitbucket', reviewMd: false },
  },
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false }),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  classifyProviderState: () => ({ status: 'connected' }),
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    data: { connected: true, integration: { accountLogin: 'alice' } },
    refetch: vi.fn(),
  }),
  useGitLabStatus: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    data: { connected: true, integration: { accountLogin: 'alice' } },
    refetch: vi.fn(),
  }),
  useGitLabWebhookWarning: () => ({ hasWebhookSyncWarning: false }),
  useReviewConfig: () => config,
  useReviewerPermission: () => permission,
  useSaveReviewConfig: () => ({ isPending: false, mutate: vi.fn() }),
  useToggleReviewer: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

function makeActionRequired(reason: string) {
  return {
    reason,
    detectedAt: '2024-01-01T00:00:00.000Z',
    lastSeenAt: '2024-01-01T00:00:00.000Z',
    lastErrorMessage: 'boom',
  };
}

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

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

async function renderScreen(): Promise<string[]> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(PlatformOverviewScreen, { scope: 'personal', platform: 'github' })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return collectText(renderer.toJSON());
}

beforeEach(() => {
  config.isLoading = false;
  config.isError = false;
  config.isFetching = false;
  config.data = null;
  config.refetch.mockClear();
  permission.status = 'ready';
  permission.canEdit = true;
});

describe('PlatformOverviewScreen actionRequired banner', () => {
  it('renders no banner when actionRequired is null', async () => {
    config.data = makeConfig({ actionRequired: null });

    const texts = await renderScreen();

    expect(texts).not.toContain('Code Reviewer needs attention');
  });

  it('renders a banner with title, description, and recovery label when actionRequired is present', async () => {
    config.data = makeConfig({
      actionRequired: makeActionRequired('github_installation_required'),
    });

    const texts = await renderScreen();

    expect(texts).toContain('Code Reviewer needs attention');
    expect(texts).toContain(
      'Code Reviewer was disabled because Kilo cannot access this repository with an active GitHub App installation. Update the GitHub App installation, then enable Code Reviewer again.'
    );
    expect(texts).toContain('Update GitHub App');
  });

  it('renders no banner when the reviewer is disabled without a blocker', async () => {
    config.data = makeConfig({ isEnabled: false, actionRequired: null });

    const texts = await renderScreen();

    expect(texts).not.toContain('Code Reviewer needs attention');
    // The disabled copy (empty state) is still present, not a banner.
    expect(texts).toContain('Automatic reviews');
  });

  it('renders the banner for every action-required reason', async () => {
    for (const reason of CODE_REVIEW_ACTION_REQUIRED_REASONS) {
      config.data = makeConfig({ actionRequired: makeActionRequired(reason) });

      // eslint-disable-next-line no-await-in-loop -- each render must commit sequentially under act
      const texts = await renderScreen();

      expect(texts).toContain('Code Reviewer needs attention');
    }
  });
});
