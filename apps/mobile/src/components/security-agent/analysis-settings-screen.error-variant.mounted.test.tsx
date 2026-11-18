// A failed first config read names its cause: a transport rejection renders
// the offline presentation, a server answer (tRPC FORBIDDEN) the server one.
// PlatformErrorScreen is mounted unmocked, so the assertion reads the variant
// through the real screen's contract with QueryError.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { AnalysisSettingsScreen } from './analysis-settings-screen';

const config = vi.hoisted(() => ({
  data: undefined as Record<string, unknown> | undefined,
  isLoading: false,
  isError: false,
  error: null as Error | null,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  refetch: vi.fn(),
}));
const catalog = vi.hoisted(() => ({
  models: [] as unknown[],
  isLoading: false,
  isError: false,
  error: undefined as Error | undefined,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
}));
const connectivity = vi.hoisted(() => ({ status: 'online' as 'online' | 'offline' | 'unknown' }));

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
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({
    ...catalog,
    isFetching: false,
    refetch: vi.fn(),
  }),
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
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/icons', () => ({
  Brain: 'Brain',
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
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: ReactNode }): ReactNode => props.headerRight ?? null,
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: 'SettingsSaveButton',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));

const mounts: Awaited<ReturnType<typeof renderWithProviders>>[] = [];

async function mount() {
  const mounted = await renderWithProviders(
    createElement(AnalysisSettingsScreen, { scope: 'personal' })
  );
  mounts.push(mounted);
  return mounted;
}

/** The QueryError node carries the `variant` prop the screen classified. */
const errorVariantScreen = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.find(node => String(node.type) === 'QueryError');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  config.data = undefined;
  config.isLoading = false;
  config.isError = false;
  config.error = null;
  config.fetchStatus = 'idle';
  config.refetch.mockReset();
  connectivity.status = 'online';
  catalog.models = [];
  catalog.isLoading = false;
  catalog.isError = false;
  catalog.error = undefined;
  catalog.fetchStatus = 'idle';
});

afterEach(() => {
  for (const mounted of mounts) {
    mounted.unmount();
  }
  mounts.length = 0;
});

describe('AnalysisSettingsScreen config load failure variant', () => {
  it('renders the offline presentation when the config read never reached the server', async () => {
    config.isError = true;
    config.error = new TypeError('Network request failed');

    const { renderer } = await mount();

    const screen = errorVariantScreen(renderer);
    expect(screen.props.variant).toBe('offline');
  });

  it('names the server when the config read answered FORBIDDEN', async () => {
    config.isError = true;
    config.error = Object.assign(new Error('boom'), {
      data: { code: 'FORBIDDEN', httpStatus: 403, message: 'boom' },
    });

    const { renderer } = await mount();

    const screen = errorVariantScreen(renderer);
    expect(screen.props.variant).toBe('server');
  });
});

describe('AnalysisSettingsScreen catalogue failure variant', () => {
  it('names the server when the catalogue read answered an HTTP status', async () => {
    // The screen mounts with a settled config, so the QueryError under test is
    // the catalogue row's, and the catalogue error carries its own status.
    config.data = { isEnabled: true };
    catalog.isError = true;
    catalog.error = Object.assign(new Error('Failed to fetch models: 500 Internal Server Error'), {
      name: 'ModelCatalogFetchError',
      status: 500,
    });

    const { renderer } = await mount();

    const row = errorVariantScreen(renderer);
    expect(row.props.variant).toBe('server');
  });

  it('names the connection when the catalogue read never reached the server', async () => {
    config.data = { isEnabled: true };
    catalog.isError = true;
    catalog.error = new TypeError('Network request failed');

    const { renderer } = await mount();

    const row = errorVariantScreen(renderer);
    expect(row.props.variant).toBe('offline');
  });
});
