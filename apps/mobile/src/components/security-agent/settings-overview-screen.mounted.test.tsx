/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts RN trees without a DOM. */
import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { renderWithProviders } from '@/test/render-with-providers';
import { ScopeEntryScreen } from './scope-entry-screen';
import { SettingsOverviewScreen } from './settings-overview-screen';

const committedConnectivity = vi.hoisted(() => ({
  status: 'online' as 'online' | 'offline' | 'unknown',
}));
const transport = vi.hoisted(() => vi.fn<typeof fetch>());
const failures = new Set<string>();
const gates = new Map<string, Promise<undefined>>();
let configData: Record<string, unknown> = {};
let repositoriesData: { id: number }[] = [];
let roles: { organizationId: string; role: string }[] = [];
let queryClient = new QueryClient();
let renderer: ReactTestRenderer | undefined = undefined;
let previousOnline = true;

vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [httpLink({ url: 'https://settings.test/api/trpc', fetch: transport })],
    }),
  };
});
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://settings.test' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
}));
vi.mock('@/components/security-agent/dashboard-screen', () => ({
  DashboardScreen: 'DashboardScreen',
}));
vi.mock('@/components/security-agent/security-agent-setup', () => ({
  SecurityAgentSetup: 'SecurityAgentSetup',
}));
vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'Switch',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  I18nManager: { isRTL: false },
  useColorScheme: () => 'light',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Clock: 'Clock',
  Cpu: 'Cpu',
  FolderGit2: 'FolderGit2',
  Zap: 'Zap',
}));
vi.mock('@/lib/hooks/use-security-agent-mutations', () => ({
  useSetSecurityAgentEnabled: () => ({ mutate: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => committedConnectivity.status,
}));
vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: 'AuditReportButton',
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

function host(root: ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}
function texts(root: ReactTestInstance) {
  return host(root, 'Text').map(node => node.props.children);
}
async function advanceBy(ms = 10) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function retry(root: ReactTestInstance) {
  const onRetry = (host(root, 'PlatformErrorScreen')[0]?.props.onRetry ??
    host(root, 'Pressable').find(node => node.props.accessibilityLabel === 'Retry')?.props
      .onPress) as (() => void) | undefined;
  if (!onRetry) {
    throw new Error('Retry was not rendered');
  }
  act(onRetry);
  await advanceBy();
}
const denialCopy =
  'Security Agent is disabled. Only organization owners and billing managers can turn it on.';
const emptyCopy = 'Select at least one repository before enabling Security Agent.';
const failureCases = [
  ['personal', 'getConfig', 'Could not load Security Agent settings'],
  ['org_123', 'getConfig', 'Could not load Security Agent settings'],
  ['org_123', 'list', 'Could not load permissions'],
  ['personal', 'getRepositories', 'Could not load repositories'],
  ['org_123', 'getRepositories', 'Could not load repositories'],
  ['personal', 'getPermissionStatus', 'Could not load permissions'],
  ['org_123', 'getPermissionStatus', 'Could not load permissions'],
] as const;
const connectivityStates = ['online', 'offline'] as const;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  previousOnline = onlineManager.isOnline();
  onlineManager.setOnline(true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: 3, gcTime: Infinity } } });
  committedConnectivity.status = 'online';
  configData = {
    isEnabled: false,
    repositorySelectionMode: 'all',
    selectedRepositoryIds: [],
    analysisMode: 'auto',
  };
  repositoriesData = [{ id: 1 }];
  roles = [{ organizationId: 'org_123', role: 'owner' }];
  failures.clear();
  gates.clear();
  transport.mockReset().mockImplementation(async input => {
    const procedure =
      new URL(input instanceof Request ? input.url : input).pathname.split('.').at(-1) ?? '';
    await gates.get(procedure);
    if (failures.has(procedure)) {
      throw new Error('Network request failed');
    }
    const data: Record<string, unknown> = {
      getPermissionStatus: { hasIntegration: true, hasPermissions: true },
      getConfig: configData,
      getRepositories: repositoriesData,
      list: roles,
      mintInstallState: { token: 'install-state' },
    };
    return Response.json({ result: { data: data[procedure] } });
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  queryClient.clear();
  onlineManager.setOnline(previousOnline);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each([
  ['standalone', SettingsOverviewScreen],
  ['inline', ScopeEntryScreen],
] as const)('%s settings real queries', (presentation, Screen) => {
  async function mount(scope = 'personal') {
    ({ renderer } = await renderWithProviders(
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <Screen scope={scope} />
      </TRPCProvider>,
      { queryClient }
    ));
    await advanceBy();
    return renderer.root;
  }

  it.each([
    ['personal', 'getRepositories', 'Select repositories'],
    ['org_123', 'list', undefined],
  ] as const)(
    'keeps unresolved %s %s distinct from empty or denied',
    async (scope, procedure, cta) => {
      gates.set(procedure, Promise.withResolvers<undefined>().promise);
      const root = await mount(scope);
      expect(host(root, 'Skeleton').length).toBeGreaterThan(0);
      expect(host(root, 'PlatformErrorScreen')).toHaveLength(0);
      expect(texts(root)).not.toContain(emptyCopy);
      expect(texts(root)).not.toContain(denialCopy);
      expect(host(root, 'ConfigureRow')[0]?.props.title).toBe(cta);
    }
  );

  const cases = failureCases.filter(
    ([, procedure]) => presentation === 'inline' || procedure !== 'getPermissionStatus'
  );
  const enabledStates = presentation === 'inline' ? [false] : [false, true];
  it.each(cases.flatMap(testCase => enabledStates.map(enabled => [testCase, enabled] as const)))(
    'settles a failed %j attempt with enabled=%s and permits Retry',
    async ([scope, procedure, message], isEnabled) => {
      configData.repositorySelectionMode = 'selected';
      configData.isEnabled = isEnabled;
      configData.selectedRepositoryIds = [1];
      onlineManager.setOnline(false);
      failures.add(procedure);
      const response = Promise.withResolvers<undefined>();
      gates.set(procedure, response.promise);
      const root = await mount(scope);
      await retry(root);
      if (procedure === 'getRepositories') {
        const progress = presentation === 'inline' ? 'Skeleton' : 'ActivityIndicator';
        expect(host(root, progress)).toHaveLength(1);
      } else {
        expect(host(root, 'PlatformErrorScreen')[0]?.props.isRetrying).toBe(true);
      }
      response.resolve(undefined);
      await advanceBy();
      const error = host(root, 'PlatformErrorScreen')[0];
      expect([error?.props.message, error?.props.errorTitle, ...texts(root)]).toContain(
        presentation === 'inline' && procedure !== 'getRepositories'
          ? 'Could not load Security Agent'
          : message
      );
      const active = queryClient.getQueryCache().findAll({ type: 'active' });
      const requests = transport.mock.calls.length;
      await advanceBy(60_000);
      expect(transport.mock.calls).toHaveLength(requests);
      // A new child can pause background refetches of already cached data.
      expect(active.filter(query => query.state.status === 'error')).toMatchObject([
        { state: { fetchStatus: 'idle' } },
      ]);
      failures.clear();
      await retry(root);
      expect(host(root, 'Switch')[0]?.props.disabled).toBe(false);
      expect(active.every(query => query.state.status === 'success')).toBe(true);
      expect(onlineManager.isOnline()).toBe(false);
    }
  );

  const cachedCases = [
    ...cases,
    ['personal', 'all', 'Could not load Security Agent settings'],
    ['org_123', 'all', 'Could not load Security Agent settings'],
  ] as const;
  it.each(
    cachedCases.flatMap(([scope, procedure, message]) =>
      connectivityStates.map(connectivity => ({ scope, procedure, message, connectivity }))
    )
  )(
    'preserves cached $scope controls and Retry after failed $procedure recovery while confirmed $connectivity',
    async ({ scope, procedure, message, connectivity }) => {
      committedConnectivity.status = connectivity;
      const root = await mount(scope);
      failures.add('getRepositories');
      act(() => {
        void queryClient.refetchQueries({ type: 'active' });
      });
      await advanceBy(10_000);
      expect(host(root, 'Switch')[0]?.props.disabled).toBe(false);
      const retryButton = root.findByProps({ role: 'button', accessibilityLabel: 'Retry' });
      expect(retryButton.props).toMatchObject({ role: 'button', accessibilityLabel: 'Retry' });
      expect(retryButton.props.className).toContain('min-h-[44px]');
      expect(retryButton.props.className).toContain('min-w-11');
      onlineManager.setOnline(false);
      failures.clear();
      const response = Promise.withResolvers<undefined>();
      const failedProcedures =
        procedure === 'all'
          ? ['getConfig', 'getPermissionStatus', 'getRepositories', 'list']
          : [procedure];
      for (const failed of failedProcedures) {
        failures.add(failed);
        gates.set(failed, response.promise);
      }
      await retry(root);
      expect(host(root, 'Switch')[0]?.props.disabled).toBe(false);
      expect(host(root, 'Pressable')[0]).toBe(retryButton);
      expect(retryButton.props.disabled).toBe(true);
      expect(retryButton.props.accessibilityState).toEqual({ disabled: true, busy: true });
      expect(host(root, 'ActivityIndicator')).toHaveLength(1);
      response.resolve(undefined);
      await advanceBy();
      expect(host(root, 'Switch')[0]?.props.disabled).toBe(false);
      expect(host(root, 'PlatformErrorScreen')).toHaveLength(0);
      expect(host(root, 'Pressable')[0]).toBe(retryButton);
      expect(retryButton.props.disabled).toBe(false);
      expect(retryButton.props.accessibilityState).toEqual({ disabled: false, busy: false });
      const status = host(root, 'Text').find(node => node.props.children === message);
      expect(status?.props.accessibilityLiveRegion).toBe('polite');
      const active = queryClient.getQueryCache().findAll({ type: 'active' });
      expect(active.every(query => query.state.fetchStatus === 'idle')).toBe(true);
      failures.clear();
      await retry(root);
      expect(host(root, 'Switch')[0]?.props.disabled).toBe(false);
      expect(texts(root)).not.toContain(message);
      expect(host(root, 'Pressable')).toHaveLength(0);
      expect(active.every(query => query.state.status === 'success')).toBe(true);
      expect(onlineManager.isOnline()).toBe(false);
    }
  );

  it.each(['personal', 'org_123'])('keeps an uncached %s unknown boot silent', async scope => {
    onlineManager.setOnline(false);
    committedConnectivity.status = 'unknown';
    const root = await mount(scope);
    expect(host(root, 'Skeleton').length).toBeGreaterThan(0);
    expect(host(root, 'PlatformErrorScreen')).toHaveLength(0);
    expect(host(root, 'SecurityAgentSetup')).toHaveLength(0);
    expect(host(root, 'Switch')).toHaveLength(0);
    expect(texts(root)).not.toContain(denialCopy);
  });
});
