/* eslint-disable max-lines -- cohesive mounted suite for the code-reviewer overview states */
// actionRequired banner contract: a non-null `actionRequired` on the reviewer
// config renders a distinct banner (title + description + recovery label)
// above the enable switch. Null renders no banner — including the
// disabled-without-blocker state, which must show the normal disabled copy,
// not a banner. This is neither the empty state nor a success check.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CODE_REVIEW_ACTION_REQUIRED_REASONS } from '@kilocode/app-shared/code-reviews';
import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';

import '@/i18n';

import { PlatformOverviewScreen } from './platform-overview-screen';

const config = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as string,
  data: null as unknown,
  refetch: vi.fn(),
}));

const provider = vi.hoisted(() => ({ status: 'connected' }));
const connectivity = vi.hoisted(() => ({ known: true }));
const platformError = vi.hoisted(() => ({
  variants: [] as string[],
  retries: [] as (() => void)[],
  retrying: [] as boolean[],
}));
const skeletonRenders = vi.hoisted(() => ({ count: 0 }));
const centeredState = vi.hoisted(() => vi.fn());
const scrollView = vi.hoisted(() => vi.fn());

const permission = vi.hoisted(() => ({
  status: 'ready',
  canEdit: true,
}));

const mintInstallState = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ token: 'install-state-token' }))
);
const launchBrowser = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openExternal = vi.hoisted(() => vi.fn());
const openPicker = vi.hoisted(() => vi.fn());

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Switch: 'Switch',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
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
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children?: unknown }) => {
    centeredState(props);
    return props.children;
  },
}));
vi.mock('@/components/agents/model-selector', () => ({
  openModelPicker: openPicker,
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: openExternal }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: launchBrowser,
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { githubApps: { mintInstallState: { mutate: mintInstallState } } },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
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
  PlatformErrorScreen: (props: {
    variant?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }) => {
    platformError.variants.push(props.variant ?? 'server');
    platformError.retrying.push(props.isRetrying ?? false);
    if (props.onRetry) {
      platformError.retries.push(props.onRetry);
    }
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: () => null,
}));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: () => null }));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => {
    skeletonRenders.count += 1;
    return null;
  },
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  // The real Button wraps its label in this provider.
  TextClassContext: { Provider: (props: { children?: unknown }) => props.children },
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => {
    scrollView(props);
    return props.children;
  },
}));
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: {
    github: { label: 'GitHub', reviewMd: true },
    gitlab: { label: 'GitLab', reviewMd: true },
    bitbucket: { label: 'Bitbucket', reviewMd: false },
  },
}));
vi.mock('@/lib/hooks/use-reviewer-models', () => ({
  useReviewerModels: () => ({ models: [], isLoading: false }),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  classifyProviderState: () => provider,
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
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => (connectivity.known ? 'offline' : 'unknown'),
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

async function render(
  scope = 'personal',
  platform: 'github' | 'gitlab' = 'github'
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(PlatformOverviewScreen, { scope, platform }));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function renderScreenHandle(platform: 'github' | 'gitlab' = 'github') {
  const renderer = await render('personal', platform);
  return {
    readTexts: () => collectText(renderer.toJSON()),
  };
}

async function renderScreen(platform: 'github' | 'gitlab' = 'github'): Promise<string[]> {
  const renderer = await render('personal', platform);
  return collectText(renderer.toJSON());
}

/** The recovery control for a banner label; empty when the label is plain text. */
function recoveryControls(
  renderer: TestRenderer.ReactTestRenderer,
  label: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root
    .findAllByType('Pressable')
    .filter(node => node.props.accessibilityLabel === label);
}

async function press(control: TestRenderer.ReactTestInstance): Promise<void> {
  await act(async () => {
    await (control.props.onPress as () => Promise<void>)();
  });
}

beforeEach(() => {
  config.isLoading = false;
  config.isError = false;
  config.isFetching = false;
  config.fetchStatus = 'idle';
  config.data = null;
  config.refetch.mockClear();
  permission.status = 'ready';
  permission.canEdit = true;
  provider.status = 'connected';
  connectivity.known = true;
  platformError.variants = [];
  platformError.retries = [];
  platformError.retrying = [];
  skeletonRenders.count = 0;
  motion.reducedMotion = false;
  centeredState.mockClear();
  scrollView.mockClear();
  mintInstallState.mockClear();
  launchBrowser.mockClear();
  openExternal.mockClear();
  openPicker.mockClear();
});

describe('PlatformOverviewScreen disconnected setup', () => {
  it.each([false, true])('centers setup with edit permission %s', async canEdit => {
    provider.status = 'disconnected';
    permission.canEdit = canEdit;
    await renderScreen();
    expect(centeredState).toHaveBeenCalledOnce();
    expect(scrollView).not.toHaveBeenCalled();
  });

  it.each([
    ['github', "GitHub isn't connected. Only organization owners and admins can connect it."],
    [
      'gitlab',
      "GitLab isn't connected. Ask an organization owner, admin, or billing manager to connect it.",
    ],
  ] as const)('states who can connect %s to a read-only viewer', async (platform, copy) => {
    provider.status = 'disconnected';
    permission.canEdit = false;

    const texts = await renderScreen(platform);

    expect(texts).toContain(copy);
  });
});

describe('PlatformOverviewScreen connected with unavailable config', () => {
  it('shows the offline error while the config query is paused with no cache', async () => {
    // The exact blank-body repro: provider status is cached as connected, the
    // config query is paused by NetInfo before its first success, and
    // `config.isLoading` (isPending && isFetching) is false while paused.
    config.fetchStatus = 'paused';
    config.data = null;

    await renderScreen();

    expect(platformError.variants).toEqual(['offline']);
    expect(skeletonRenders.count).toBe(0);
  });

  it('keeps the skeleton while the query is paused and connectivity is unsettled', async () => {
    config.fetchStatus = 'paused';
    config.data = null;
    connectivity.known = false;

    const texts = await renderScreen();

    // Connectivity not yet settled: no confirmed-offline signal, so the
    // loading skeleton renders while the query waits instead of a blank body.
    expect(platformError.variants).toEqual([]);
    expect(skeletonRenders.count).toBeGreaterThan(0);
    expect(texts).not.toContain('Automatic reviews');
  });

  it('renders content from cache when the config query is paused with data', async () => {
    config.fetchStatus = 'paused';
    config.data = makeConfig();

    const texts = await renderScreen();

    expect(platformError.variants).toEqual([]);
    expect(skeletonRenders.count).toBe(0);
    expect(texts).toContain('Automatic reviews');
  });

  it('shows the server error when the config fetch fails with no cache', async () => {
    config.isError = true;
    config.data = null;

    await renderScreen();

    expect(platformError.variants).toEqual(['server']);
    expect(skeletonRenders.count).toBe(0);
  });
});

describe('PlatformOverviewScreen pending idle config read', () => {
  afterEach(() => {
    vi.useRealTimers();
    // A test's refetch implementation must not reach the next one or the
    // timers of a later test.
    config.refetch.mockReset();
  });

  it('shows the skeleton instead of a blank body while nothing is fetching', async () => {
    // Pending, idle, no data, no error: exactly the state a cancelled first
    // fetch reverts to. It matched none of the separate isLoading/isError/
    // paused tests, so the header painted over an empty scroll area with
    // nothing that would ever resolve it.
    config.fetchStatus = 'idle';

    const texts = await renderScreen();

    expect(skeletonRenders.count).toBeGreaterThan(0);
    expect(platformError.variants).toEqual([]);
    expect(texts).not.toContain('Automatic reviews');
  });

  it('restarts the idle read on its own and paints the rows once it lands', async () => {
    vi.useFakeTimers();
    config.fetchStatus = 'idle';
    config.refetch.mockImplementation(() => {
      config.fetchStatus = 'idle';
      config.data = makeConfig();
      return Promise.resolve();
    });

    const { readTexts } = await renderScreenHandle();
    expect(readTexts()).not.toContain('Automatic reviews');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
    expect(platformError.variants).toEqual([]);
    expect(readTexts()).toContain('Automatic reviews');
  });

  it('ends on the error with Retry when the idle read cannot restart', async () => {
    vi.useFakeTimers();
    config.fetchStatus = 'idle';
    // This read cannot be restarted: the attempt leaves it exactly as idle.
    config.refetch.mockImplementation(() => Promise.resolve());

    const { readTexts } = await renderScreenHandle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    // The single automatic attempt did not get a fetch running, so the body
    // stops waiting behind a spinner and offers the action that can.
    expect(config.refetch).toHaveBeenCalledTimes(1);
    expect(platformError.variants).toEqual(['server']);
    expect(readTexts()).not.toContain('Automatic reviews');

    skeletonRenders.count = 0;
    await act(() => {
      platformError.retries.at(-1)?.();
    });

    // Retry restarts the read and returns the body to the loading state while
    // a fresh cycle (with its own single automatic attempt) runs.
    expect(config.refetch).toHaveBeenCalledTimes(2);
    expect(skeletonRenders.count).toBeGreaterThan(0);
    expect(platformError.variants).toEqual(['server']);
  });
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

describe('PlatformOverviewScreen actionRequired recovery', () => {
  async function pressRecovery(
    label: string,
    scope = 'personal',
    platform: 'github' | 'gitlab' = 'github'
  ): Promise<TestRenderer.ReactTestRenderer> {
    const renderer = await render(scope, platform);
    const controls = recoveryControls(renderer, label);
    expect(controls).toHaveLength(1);
    await press(controls[0] as TestRenderer.ReactTestInstance);
    return renderer;
  }

  it('opens the GitHub App installation and re-reads the config on return', async () => {
    config.data = makeConfig({
      actionRequired: makeActionRequired('github_installation_required'),
    });

    await pressRecovery('Update GitHub App');

    expect(mintInstallState).toHaveBeenCalledWith({
      organizationId: undefined,
      returnTo: '/cloud/sessions',
    });
    expect(launchBrowser).toHaveBeenCalledWith(
      'https://app.kilo.ai/github-app?installState=install-state-token&fromApp=1'
    );
    // Returning from the browser re-reads the config, so a fixed reviewer clears the banner.
    expect(config.refetch).toHaveBeenCalledTimes(1);
  });

  it('scopes the GitHub App installation to the organization', async () => {
    config.data = makeConfig({
      actionRequired: makeActionRequired('github_installation_required'),
    });

    await pressRecovery('Update GitHub App', 'org-1');

    expect(mintInstallState).toHaveBeenCalledWith({
      organizationId: 'org-1',
      returnTo: '/cloud/sessions',
    });
    expect(launchBrowser).toHaveBeenCalledWith(
      'https://app.kilo.ai/github-app?organizationId=org-1&installState=install-state-token&fromApp=1'
    );
  });

  it('falls back to the integration page when minting an install state is refused', async () => {
    // Organizations whose members can edit the config but not mint an install
    // state, and organizations that already hold an installation, still reach
    // the page that opens the install/manage flow.
    mintInstallState.mockImplementationOnce(() =>
      Promise.reject(new Error('This organization already has a GitHub installation'))
    );
    config.data = makeConfig({
      actionRequired: makeActionRequired('github_installation_required'),
    });

    await pressRecovery('Update GitHub App', 'org-1');

    expect(launchBrowser).toHaveBeenCalledWith(
      'https://app.kilo.ai/github-app?organizationId=org-1'
    );
    expect(config.refetch).toHaveBeenCalledTimes(1);
  });

  it('opens the GitLab integration page for a project-access block', async () => {
    config.data = makeConfig({
      actionRequired: makeActionRequired('gitlab_project_access_required'),
    });

    await pressRecovery('Update GitLab integration', 'org-1', 'gitlab');

    expect(launchBrowser).toHaveBeenCalledWith(
      'https://app.kilo.ai/organizations/org-1/integrations/gitlab'
    );
    expect(config.refetch).toHaveBeenCalledTimes(1);
  });

  it('opens the BYOK settings page for an invalid key', async () => {
    config.data = makeConfig({ actionRequired: makeActionRequired('byok_invalid_key') });

    await pressRecovery('Update BYOK settings');

    expect(launchBrowser).toHaveBeenCalledWith('https://app.kilo.ai/byok');
  });

  it('opens the reviewer model picker for an unavailable model', async () => {
    config.data = makeConfig({
      actionRequired: makeActionRequired('selected_model_unavailable'),
    });

    await pressRecovery('Update Code Reviewer settings');

    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it.each(['github_ip_allow_list', 'repeated_repository_clone_timeout'] as const)(
    'emails support for %s',
    async reason => {
      config.data = makeConfig({ actionRequired: makeActionRequired(reason) });

      await pressRecovery('Contact support');

      expect(openExternal).toHaveBeenCalledWith(`mailto:${SUPPORT_EMAIL}`, {
        label: SUPPORT_EMAIL,
      });
      expect(launchBrowser).not.toHaveBeenCalled();
    }
  );

  it('keeps the label as plain text for a member who cannot edit the config', async () => {
    permission.canEdit = false;
    config.data = makeConfig({
      actionRequired: makeActionRequired('github_installation_required'),
    });

    const renderer = await render();
    const texts = collectText(renderer.toJSON());

    expect(texts).toContain('Update GitHub App');
    expect(recoveryControls(renderer, 'Update GitHub App')).toHaveLength(0);
    // The who-can-fix note is the member's explanation, not a control.
    expect(texts).toContain(
      'Only organization owners, admins, and billing managers can change these settings.'
    );
  });
});

describe('PlatformOverviewScreen rows entrance', () => {
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

    const renderer = await render();

    expect(rowsContainer(renderer)?.props.entering).toBeUndefined();
  });

  it('keeps the crossfade entrance while motion is allowed', async () => {
    motion.reducedMotion = false;
    config.data = makeConfig();

    const renderer = await render();

    expect(rowsContainer(renderer)?.props.entering).toBeDefined();
  });
});
