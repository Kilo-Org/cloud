// The screen's read states, each named by its own cause: a first config read the
// online manager paused, a role read that failed or is paused, and a model
// catalogue that failed or delivered nothing to pick from. PlatformErrorScreen
// is mounted unmocked, so the paused branch is asserted through the real
// screen's contract with QueryError.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TestRenderer } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { i18n } from '@/i18n';
import { AnalysisSettingsScreen } from './analysis-settings-screen';

const capability = vi.hoisted(() => ({
  status: 'allowed' as 'loading' | 'error' | 'denied' | 'allowed',
  isPending: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
}));
const config = vi.hoisted(() => ({
  data: undefined as Record<string, unknown> | undefined,
  isLoading: false,
  isError: false,
  isPending: false,
  error: null as Error | null,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  refetch: vi.fn(),
}));
const catalog = vi.hoisted(() => ({
  models: [] as unknown[],
  isError: false,
  error: undefined as Error | undefined,
  isFetched: false,
  isFetching: false,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  refetch: vi.fn(),
}));
const pausedRetry = vi.hoisted(() => ({ retry: vi.fn(), isRetrying: false }));
const settingsRecovery = vi.hoisted(() => ({
  retry: vi.fn(),
  isRetrying: false,
}));
// The recovery row is stubbed so a case can read the props the screen chose and
// press the Retry the row would have wired.
const recoveryCards = vi.hoisted(() => ({
  props: [] as { message?: string; isRetrying: boolean; onRetry: () => void }[],
}));
// QueryError is stubbed the same way, so a case reads the failure the real
// PlatformErrorScreen or the catalogue row handed it, including its Retry.
const failureScreens = vi.hoisted(() => ({
  props: [] as {
    variant?: string;
    title?: string;
    isRetrying?: boolean;
    onRetry?: () => void;
  }[],
}));
const connectivity = vi.hoisted(() => ({
  status: 'online' as 'online' | 'offline' | 'unknown',
}));

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => connectivity.status,
}));
vi.mock('react-native', () => ({
  View: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
  Pressable: 'Pressable',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-single-push-route', () => ({
  useSinglePushRoute: () => vi.fn(),
}));
vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => capability,
  useSecurityAgentConfig: () => config,
  useRetrySecurityAgentConfig: () => pausedRetry,
  useRetrySecurityAgentSettings: () => settingsRecovery,
  useSaveSecurityAgentConfig: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => catalog,
}));
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSecurityAgentSettingsRedirect: () => undefined,
  useSettingsBackGuard: () => ({
    onBack: vi.fn(),
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useMutedDisabledInk: () => '#fff',
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: 'ConfigureRow',
}));
vi.mock('@/components/ui/icons', () => ({
  Brain: 'Brain',
  Check: 'Check',
  Search: 'Search',
  Wrench: 'Wrench',
  WifiOff: 'WifiOff',
  ServerCrash: 'ServerCrash',
}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
}));
vi.mock('@/components/agents/model-selector', () => ({
  openModelPicker: vi.fn(),
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    title?: string;
    isRetrying?: boolean;
    onRetry?: () => void;
  }) => {
    failureScreens.props.push(props);
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }): ReactNode => props.headerRight ?? null,
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: 'SettingsSaveButton',
}));
vi.mock('@/components/security-agent/settings-recovery-status', () => ({
  SettingsRecoveryStatus: (props: {
    message?: string;
    isRetrying: boolean;
    onRetry: () => void;
  }) => {
    recoveryCards.props.push(props);
    return null;
  },
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));

const mounts: RenderWithProvidersResult[] = [];

async function mount() {
  const mounted = await renderWithProviders(
    createElement(AnalysisSettingsScreen, { scope: 'personal' })
  );
  mounts.push(mounted);
  return mounted;
}

function enabledConfig(): Record<string, unknown> {
  return {
    isEnabled: true,
    triageModelSlug: 'vendor/triage',
    analysisModelSlug: 'vendor/analysis',
    remediationModelSlug: 'vendor/remediation',
    analysisMode: 'auto',
  };
}

function hostElements(renderer: TestRenderer.ReactTestRenderer, type: string) {
  return renderer.root.findAll(node => String(node.type) === type);
}

/** Whether any rendered line carries exactly this copy. */
function paints(renderer: TestRenderer.ReactTestRenderer, copy: string): boolean {
  return hostElements(renderer, 'Text').some(node => node.props.children === copy);
}

/** The lock state of the depth picker's three segments, in render order. */
function depthSegmentsLocked(renderer: TestRenderer.ReactTestRenderer): boolean[] {
  const segments = hostElements(renderer, 'Pressable');
  expect(segments).toHaveLength(3);
  return segments.map(segment => segment.props.disabled === true);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  capability.status = 'allowed';
  capability.isPending = false;
  capability.fetchStatus = 'idle';
  config.data = undefined;
  config.isLoading = false;
  config.isError = false;
  config.isPending = false;
  config.error = null;
  config.fetchStatus = 'idle';
  config.refetch.mockReset();
  pausedRetry.retry.mockReset();
  pausedRetry.isRetrying = false;
  settingsRecovery.retry.mockReset();
  settingsRecovery.isRetrying = false;
  recoveryCards.props = [];
  failureScreens.props = [];
  connectivity.status = 'online';
  catalog.models = [];
  catalog.isError = false;
  catalog.error = undefined;
  catalog.isFetched = false;
  catalog.isFetching = false;
  catalog.fetchStatus = 'idle';
  catalog.refetch.mockReset();
});

afterEach(() => {
  for (const mounted of mounts) {
    mounted.unmount();
  }
  mounts.length = 0;
});

describe('AnalysisSettingsScreen paused first config read', () => {
  it('names the connection and retries the paused read instead of refetching it plain', async () => {
    // The online manager paused the cold read on a confirmed-offline device:
    // pending, no data, no error. The loading gate would hold the skeleton
    // until connectivity returns.
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.status = 'offline';

    await mount();

    expect(failureScreens.props).toHaveLength(1);
    const screen = failureScreens.props[0];
    expect(screen?.variant).toBe('offline');
    expect(screen?.title).toBe(i18n.t('securityAgent.analysisSettings.couldNotLoad'));
    screen?.onRetry?.();
    expect(pausedRetry.retry).toHaveBeenCalledOnce();
    expect(config.refetch).not.toHaveBeenCalled();
  });

  it('keeps the skeleton while a pause cannot be attributed to the connection yet', async () => {
    // The manager also pauses on an unsettled NetInfo report, which is the
    // normal cold-launch window: that is not a connection failure yet.
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.status = 'unknown';

    const { renderer } = await mount();

    expect(failureScreens.props).toHaveLength(0);
    expect(hostElements(renderer, 'Skeleton').length).toBeGreaterThan(0);
  });

  it("carries the paused retry hook's busy state into the failure screen", async () => {
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.status = 'offline';
    pausedRetry.isRetrying = true;

    await mount();

    expect(failureScreens.props[0]?.isRetrying).toBe(true);
  });
});

describe('AnalysisSettingsScreen model catalogue states', () => {
  it('shows one retryable failure and no pickable row when the read delivered nothing', async () => {
    config.data = enabledConfig();
    catalog.isError = true;
    catalog.error = new TypeError('Network request failed');

    const { renderer } = await mount();

    expect(failureScreens.props).toHaveLength(1);
    expect(failureScreens.props[0]?.title).toBe(i18n.t('common.couldNotLoadModels'));
    expect(hostElements(renderer, 'ConfigureRow')).toHaveLength(0);
  });

  it('keeps the rows but disables them under one notice for a delivered empty catalogue', async () => {
    // A delivered empty catalogue is not a failure, and it is not a choice
    // either: the setting still reads as a setting, with nothing to pick.
    config.data = enabledConfig();
    catalog.models = [];
    catalog.isFetched = true;

    const { renderer } = await mount();

    const rows = hostElements(renderer, 'ConfigureRow');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.props.disabled).toBe(true);
    }
    expect(paints(renderer, i18n.t('common.noModelsAvailable'))).toBe(true);
    expect(failureScreens.props).toHaveLength(0);
  });
});

describe('AnalysisSettingsScreen role read states', () => {
  it('offers a retry for the settings set when the role read failed, without locking the controls', async () => {
    // A failed role read is not evidence that the viewer cannot manage the
    // settings, so the controls stay live under the recovery row.
    config.data = enabledConfig();
    capability.status = 'error';

    const { renderer } = await mount();

    expect(recoveryCards.props).toHaveLength(1);
    expect(recoveryCards.props[0]?.message).toBe(
      i18n.t('securityAgent.settingsOverview.couldNotLoadPermissions')
    );
    expect(recoveryCards.props[0]?.isRetrying).toBe(false);
    recoveryCards.props[0]?.onRetry();
    expect(settingsRecovery.retry).toHaveBeenCalledOnce();
    expect(depthSegmentsLocked(renderer)).toEqual([false, false, false]);
    expect(paints(renderer, i18n.t('securityAgent.sla.permissionNote'))).toBe(false);
  });

  it('locks the controls and says why once the role read settles as a denial', async () => {
    config.data = enabledConfig();
    capability.status = 'denied';

    const { renderer } = await mount();

    expect(recoveryCards.props).toHaveLength(0);
    expect(depthSegmentsLocked(renderer)).toEqual([true, true, true]);
    expect(paints(renderer, i18n.t('securityAgent.sla.permissionNote'))).toBe(true);
  });

  it('paints no recovery row for a role read that is simply still in flight', async () => {
    // A plain in-flight role read has not answered yet; an error card there
    // would claim a failure the read never reported.
    config.data = enabledConfig();
    capability.status = 'loading';
    capability.isPending = true;
    capability.fetchStatus = 'fetching';

    const { renderer } = await mount();

    expect(recoveryCards.props).toHaveLength(0);
    expect(depthSegmentsLocked(renderer)).toEqual([false, false, false]);
  });
});
