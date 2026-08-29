/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts RN trees without a DOM. */
import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { ScopeEntryScreen } from './scope-entry-screen';
import { SettingsOverviewScreen } from './settings-overview-screen';

const transport = vi.hoisted(() => vi.fn<typeof fetch>());
let permissionData = {
  hasIntegration: true,
  hasPermissions: true,
  reauthorizeUrl: null as string | null,
};
let configData: Record<string, unknown> = {};
let repositoriesData: { id: number }[] = [];
let roles: { organizationId: string; role: string }[] = [];
let queryClient = new QueryClient();
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
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
vi.mock('react-native', () => ({ View: 'View', Switch: 'Switch' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
}));
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
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: 'AuditReportButton',
}));
vi.mock('@/components/security-agent/dashboard-screen', () => ({
  DashboardScreen: 'DashboardScreen',
}));
vi.mock('@/components/security-agent/security-agent-setup', () => ({
  SecurityAgentSetup: 'SecurityAgentSetup',
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: 'PlatformErrorScreen',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

function host(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}
function procedureFor(input: Parameters<typeof fetch>[0]) {
  return new URL(input instanceof Request ? input.url : input).pathname.split('.').at(-1) ?? '';
}
async function advanceBy() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}
async function mount(scope = 'personal', Screen = ScopeEntryScreen) {
  await act(() => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TRPCProvider, {
          trpcClient,
          queryClient,
          // eslint-disable-next-line react/no-children-prop -- tRPC requires this prop in createElement calls without JSX.
          children: createElement(Screen, { scope }),
        })
      )
    );
  });
  await advanceBy();
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer.root;
}
async function retry(root: TestRenderer.ReactTestInstance) {
  const onRetry = host(root, 'PlatformErrorScreen')[0]?.props.onRetry as () => void;
  act(onRetry);
  await advanceBy();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  previousOnline = onlineManager.isOnline();
  onlineManager.setOnline(true);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  permissionData = { hasIntegration: true, hasPermissions: true, reauthorizeUrl: null };
  configData = {
    hasConfig: false,
    isEnabled: false,
    repositorySelectionMode: 'all',
    selectedRepositoryIds: [],
    analysisMode: 'auto',
  };
  repositoriesData = [{ id: 1 }];
  roles = [{ organizationId: 'org_123', role: 'owner' }];
  transport.mockReset().mockImplementation(async input => {
    await Promise.resolve();
    const data: Record<string, unknown> = {
      getPermissionStatus: permissionData,
      getConfig: configData,
      getRepositories: repositoriesData,
      list: roles,
      mintInstallState: { token: 'install-state' },
    };
    return Response.json({ result: { data: data[procedureFor(input)] } });
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

describe.each(['personal', 'org_123'])('ScopeEntryScreen %s routing', scope => {
  it.each([false, true])('mints a setup URL with hasIntegration=%s', async hasIntegration => {
    permissionData = { hasIntegration, hasPermissions: false, reauthorizeUrl: null };
    const root = await mount(scope);
    const setup = host(root, 'SecurityAgentSetup')[0];
    const url = new URL(setup?.props.url as string);
    expect(url.origin).toBe('https://settings.test');
    expect(url.pathname).toBe('/github-app');
    expect(url.searchParams.get('installState')).toBe('install-state');
    expect(url.searchParams.get('fromApp')).toBe('1');
    expect(url.searchParams.get('organizationId')).toBe(scope === 'personal' ? null : scope);
    expect(setup?.props.buttonLabel).toBe(
      hasIntegration ? 'Re-authorize GitHub App' : 'Install GitHub App'
    );
    expect(host(root, 'Switch')).toHaveLength(0);
    expect(host(root, 'DashboardScreen')).toHaveLength(0);
  });

  it('uses the server reauthorization URL without minting another token', async () => {
    permissionData = {
      hasIntegration: true,
      hasPermissions: false,
      reauthorizeUrl: 'https://github.com/apps/kilo/installations/123',
    };
    const root = await mount(scope);
    expect(host(root, 'SecurityAgentSetup')[0]?.props.url).toBe(permissionData.reauthorizeUrl);
    expect(host(root, 'Switch')).toHaveLength(0);
    expect(transport.mock.calls.some(([input]) => procedureFor(input) === 'mintInstallState')).toBe(
      false
    );
  });

  it.each([false, true])(
    'opens the configured destination without minting when enabled=%s',
    async isEnabled => {
      configData.isEnabled = isEnabled;
      const root = await mount(scope);
      expect(host(root, 'DashboardScreen')).toHaveLength(isEnabled ? 1 : 0);
      expect(host(root, 'Switch')).toHaveLength(isEnabled ? 0 : 1);
      expect(host(root, 'SecurityAgentSetup')).toHaveLength(0);
      expect(
        transport.mock.calls.some(([input]) => procedureFor(input) === 'mintInstallState')
      ).toBe(false);
    }
  );
});

describe.each([
  ['standalone', SettingsOverviewScreen],
  ['inline', ScopeEntryScreen],
] as const)('%s settings readiness and access', (presentation, Screen) => {
  it.each([
    ['selected', [], { repos: [], disabled: true, cta: false }],
    ['selected', [], { repos: [{ id: 1 }], disabled: true, cta: true }],
    ['selected', [1], { repos: [], disabled: false, cta: false }],
    ['all', [], { repos: [{ id: 1 }], disabled: false, cta: false }],
    ['all', [], { repos: [], disabled: true, cta: false }],
  ] as const)(
    'preserves setup controls for %s, selection %j and repositories %j',
    async (mode, selected, expected) => {
      configData.repositorySelectionMode = mode;
      configData.selectedRepositoryIds = selected;
      repositoriesData = [...expected.repos];
      onlineManager.setOnline(false);
      const root = await mount('personal', Screen);
      await retry(root);
      expect(host(root, 'Switch')[0]?.props.value).toBe(false);
      expect(host(root, 'Switch')[0]?.props.disabled).toBe(expected.disabled);
      expect(
        host(root, 'Text').some(
          node =>
            node.props.children === 'Select at least one repository before enabling Security Agent.'
        )
      ).toBe(expected.disabled);
      expect(
        host(root, 'ConfigureRow').some(node => node.props.title === 'Select repositories')
      ).toBe(expected.cta);
    }
  );

  it.each(['member', 'absent'])(
    'keeps the %s organization role restricted after Retry',
    async role => {
      roles = role === 'absent' ? [] : [{ organizationId: 'org_123', role }];
      onlineManager.setOnline(false);
      const root = await mount('org_123', Screen);
      await retry(root);
      expect(host(root, 'Switch')).toHaveLength(0);
      expect(host(root, 'ConfigureRow')).toHaveLength(0);
      expect(host(root, 'ScreenHeader')[0]?.props.headerRight).toBeNull();
      expect(host(root, 'Text').map(node => node.props.children)).toContain(
        'Security Agent is disabled. Only organization owners and billing managers can turn it on.'
      );
      expect(host(root, 'PlatformErrorScreen')).toHaveLength(0);
    }
  );

  it('recovers a paused organization capability without changing other queries or future fetching', async () => {
    onlineManager.setOnline(false);
    const trpc = createTRPCOptionsProxy<MobileRouter>({ client: trpcClient, queryClient });
    const configKey = trpc.organizations.securityAgent.getConfig.queryKey({
      organizationId: 'org_123',
    });
    const other = trpc.securityAgent.getConfig.queryOptions();
    void queryClient.prefetchQuery(other);
    queryClient.setQueryData(configKey, configData);
    const root = await mount('org_123', Screen);
    const error = host(root, 'PlatformErrorScreen')[0];
    expect(error?.props.message ?? error?.props.errorTitle).toBe(
      presentation === 'inline' ? 'Could not load Security Agent' : 'Could not load permissions'
    );
    await retry(root);
    expect(host(root, 'Switch')[0]?.props.disabled).toBe(false);
    expect(queryClient.getQueryState(other.queryKey)?.fetchStatus).toBe('paused');
    expect(onlineManager.isOnline()).toBe(false);
    act(() => {
      void queryClient.refetchQueries({ queryKey: configKey, exact: true });
    });
    await advanceBy();
    expect(queryClient.getQueryState(configKey)?.fetchStatus).toBe('paused');
  });
});
