// Mock registrations for analysis-settings-screen.states.mounted.test.tsx. They
// live here so the suite stays under the max-lines budget (same pattern as
// automation-settings-screen.mounted.test-helpers.tsx). The suite imports this
// module FIRST, before any other import, so the registrations are in place
// before the screen module evaluates.
//
// The component the suite mocks is never imported here: the test file imports
// it, hands the element to `mount`, and drives it through the exported mock
// state.

import { type ReactElement, type ReactNode } from 'react';
import { expect, vi } from 'vitest';

import { type TestRenderer } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

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
  isLoading: false,
  isFetched: false,
  isFetching: false,
  hasDeliveredData: false,
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

async function mount(screen: ReactElement) {
  const mounted = await renderWithProviders(screen);
  mounts.push(mounted);
  return mounted;
}

/**
 * Binds the screen element the suite mounts, so its cases keep calling `mount()`
 * while this module never imports the screen under test.
 */
function mountFor(screen: ReactElement): () => Promise<RenderWithProvidersResult> {
  return () => mount(screen);
}

/** Every suite's `afterEach`: unmount each tree the case mounted. */
function unmountAll(): void {
  for (const mounted of mounts) {
    mounted.unmount();
  }
  mounts.length = 0;
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

export {
  capability,
  catalog,
  config,
  connectivity,
  depthSegmentsLocked,
  enabledConfig,
  failureScreens,
  hostElements,
  mountFor,
  paints,
  pausedRetry,
  recoveryCards,
  settingsRecovery,
  unmountAll,
};
