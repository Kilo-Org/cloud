/* eslint-disable max-lines -- one mounted harness covers the setup states: mount mint failure, press-time re-mint, and reauthorization */
import { type MobileRouter } from '@kilocode/trpc/mobile';
import { securityConfigFixture } from './security-config.test-fixture';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createElement } from 'react';
import { act, type TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { renderWithProviders } from '@/test/render-with-providers';
import { ScopeEntryScreen } from './scope-entry-screen';
import { SettingsOverviewScreen } from './settings-overview-screen';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);
let permissionData = {
  hasIntegration: true,
  hasPermissions: true,
  reauthorizeUrl: null as string | null,
};
let configData = structuredClone(securityConfigFixture);
let repositoriesData: { id: number }[] = [];
let roles: { organizationId: string; role: string }[] = [];
let queryClient = new QueryClient();
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let previousOnline = true;
let mintFailed = false;
let configHold: Promise<boolean> | undefined = undefined;
let deniedProcedures = new Set<string>();
let sessionAuthRequired = false;
const DENIAL_MESSAGE = 'You do not have access to this organization';

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
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
vi.mock('@/components/organization/scope-access-denied-screen', () => ({
  ScopeAccessDeniedScreen: 'ScopeAccessDeniedScreen',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));

function host(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}
function procedureFor(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input).pathname.split('.').at(-1) ?? '';
}
async function advanceBy() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}
async function mount(scope = 'personal', Screen = ScopeEntryScreen) {
  const mounted = await renderWithProviders(
    createElement(TRPCProvider, {
      trpcClient,
      queryClient,
      // eslint-disable-next-line react/no-children-prop -- tRPC requires this prop in createElement calls without JSX.
      children: createElement(Screen, { scope }),
    }),
    { queryClient }
  );
  renderer = mounted.renderer;
  await advanceBy();
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
  configData = structuredClone(securityConfigFixture);
  mintFailed = false;
  configHold = undefined;
  deniedProcedures = new Set();
  sessionAuthRequired = false;
  repositoriesData = [{ id: 1 }];
  roles = [{ organizationId: 'org_123', role: 'owner' }];
  transport.mockReset().mockImplementation(async input => {
    await Promise.resolve();
    if (configHold && procedureFor(input) === 'getConfig') {
      await configHold;
    }
    if (mintFailed && procedureFor(input) === 'mintInstallState') {
      throw new Error('Setup failed');
    }
    if (deniedProcedures.has(procedureFor(input))) {
      return Response.json(
        {
          error: {
            message: DENIAL_MESSAGE,
            code: -32_003,
            data: {
              code: 'UNAUTHORIZED',
              httpStatus: 401,
              authRequired: sessionAuthRequired,
              path: procedureFor(input),
            },
          },
        },
        { status: 401 }
      );
    }
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

  it.each([false, true])(
    'keeps the setup screen usable when setup mint fails with integration=%s',
    async hasIntegration => {
      permissionData = { hasIntegration, hasPermissions: false, reauthorizeUrl: null };
      mintFailed = true;
      const root = await mount(scope);
      expect(host(root, 'ScreenHeader')).toHaveLength(1);
      expect(host(root, 'PlatformErrorScreen')).toHaveLength(0);
      expect(host(root, 'QueryError')).toHaveLength(0);
      const setup = host(root, 'SecurityAgentSetup')[0];
      expect(setup).toBeDefined();
      expect(setup?.props.url).toBeUndefined();
      // A press resolves (re-mints) the URL; still failing, it reports none.
      const resolve = setup?.props.resolveUrl as (() => Promise<unknown>) | undefined;
      await expect(resolve?.()).resolves.toBeUndefined();
      expect(
        transport.mock.calls.filter(([input]) => procedureFor(input) === 'mintInstallState')
      ).toHaveLength(2);
    }
  );

  it.each([false, true])(
    'resolves a fresh URL on press after a mount-time mint failure with integration=%s',
    async hasIntegration => {
      permissionData = { hasIntegration, hasPermissions: false, reauthorizeUrl: null };
      mintFailed = true;
      const root = await mount(scope);
      const setup = host(root, 'SecurityAgentSetup')[0];
      expect(setup?.props.url).toBeUndefined();
      mintFailed = false;
      const resolve = setup?.props.resolveUrl as (() => Promise<unknown>) | undefined;
      const resolved = new URL((await resolve?.()) as string);
      expect(resolved.origin + resolved.pathname).toBe('https://settings.test/github-app');
      expect(resolved.searchParams.get('installState')).toBe('install-state');
      expect(resolved.searchParams.get('fromApp')).toBe('1');
      expect(resolved.searchParams.get('organizationId')).toBe(scope === 'personal' ? null : scope);
    }
  );

  it.each([false, true])(
    'keeps the setup mounted during a press-time re-mint with integration=%s',
    async hasIntegration => {
      permissionData = { hasIntegration, hasPermissions: false, reauthorizeUrl: null };
      const root = await mount(scope);
      const setup = host(root, 'SecurityAgentSetup')[0];
      if (!setup) {
        throw new Error('expected the setup screen');
      }
      act(() => {
        void (setup.props.resolveUrl as () => Promise<unknown>)();
      });
      expect(host(root, 'SecurityAgentSetup')).toHaveLength(1);
      expect(host(root, 'Skeleton')).toHaveLength(0);
      await advanceBy();
      expect(host(root, 'SecurityAgentSetup')[0]?.props.url).toBeDefined();
    }
  );

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

describe('ScopeEntryScreen dashboard first mount', () => {
  it('paints the enabled dashboard on the first mount with no entering animation above it', async () => {
    configData.isEnabled = true;
    const root = await mount('personal');
    const dashboard = host(root, 'DashboardScreen')[0];
    expect(dashboard).toBeDefined();

    // A Reanimated entering animation carries `initialValues: { opacity: 0 }`.
    // On an ancestor of the dashboard it starts the header and the whole body
    // at opacity 0, so a first mount whose entrance is dropped leaves the
    // screen blank while only the tab bar outside the screen paints.
    const ancestorsWithEntering: string[] = [];
    for (let node = dashboard?.parent ?? null; node; node = node.parent) {
      if ('entering' in node.props) {
        ancestorsWithEntering.push(String(node.type));
      }
    }
    expect(ancestorsWithEntering).toEqual([]);
    expect(host(root, 'Animated.View')).toHaveLength(0);
  });

  it('renders the loading skeleton, then the dashboard, on the first mount', async () => {
    configData.isEnabled = true;
    const held = Promise.withResolvers<boolean>();
    configHold = held.promise;

    const root = await mount('personal');
    // Pending settings keep the screen on the header + skeleton, never on an
    // empty body.
    expect(host(root, 'ScreenHeader')).toHaveLength(1);
    expect(host(root, 'Skeleton').length).toBeGreaterThan(0);
    expect(host(root, 'DashboardScreen')).toHaveLength(0);

    act(() => {
      held.resolve(true);
    });
    await advanceBy();
    await advanceBy();
    await advanceBy();

    expect(host(root, 'DashboardScreen')).toHaveLength(1);
    expect(host(root, 'Skeleton')).toHaveLength(0);
  });
});

describe('ScopeEntryScreen organization access', () => {
  it('shows the no-access state instead of the setup when the organization denies access', async () => {
    // The organization still appears in the cached membership list — the state
    // the old build rendered as the personal first-run setup.
    permissionData = { hasIntegration: false, hasPermissions: false, reauthorizeUrl: null };
    deniedProcedures = new Set(['getPermissionStatus', 'getConfig', 'getRepositories']);
    const root = await mount('org_123');
    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(1);
    expect(host(root, 'ScopeAccessDeniedScreen')[0]?.props.kind).toBe('denied');
    expect(host(root, 'SecurityAgentSetup')).toHaveLength(0);
    expect(host(root, 'DashboardScreen')).toHaveLength(0);
    // No install-state token is minted for a scope the reader cannot use.
    expect(transport.mock.calls.some(([input]) => procedureFor(input) === 'mintInstallState')).toBe(
      false
    );
  });

  it('keeps cached organization data out of view when one of its queries is denied', async () => {
    const trpc = createTRPCOptionsProxy<MobileRouter>({ client: trpcClient, queryClient });
    queryClient.setQueryData(
      trpc.organizations.securityAgent.getConfig.queryKey({ organizationId: 'org_123' }),
      configData
    );
    queryClient.setQueryData(
      trpc.organizations.securityAgent.getPermissionStatus.queryKey({ organizationId: 'org_123' }),
      {
        hasIntegration: true,
        hasPermissions: true,
        integrationId: 'int_1',
        reauthorizeUrl: null,
        authInvalidAt: null,
        authInvalidReason: null,
      }
    );
    // Only the config read is denied; its cached value alone would render the
    // dashboard, so the denial has to outrank cached data.
    deniedProcedures = new Set(['getConfig']);
    const root = await mount('org_123');
    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(1);
    expect(host(root, 'DashboardScreen')).toHaveLength(0);
    expect(host(root, 'PlatformErrorScreen')).toHaveLength(0);
  });

  it('shows the organization landing again when Retry finds access restored', async () => {
    permissionData = { hasIntegration: true, hasPermissions: true, reauthorizeUrl: null };
    configData.isEnabled = true;
    deniedProcedures = new Set(['getPermissionStatus', 'getConfig', 'getRepositories']);
    const root = await mount('org_123');
    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(1);

    deniedProcedures = new Set();
    sessionAuthRequired = false;
    const onRetry = host(root, 'ScopeAccessDeniedScreen')[0]?.props.onRetry as () => void;
    act(onRetry);
    await advanceBy();
    await advanceBy();
    await advanceBy();

    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(0);
    expect(host(root, 'DashboardScreen')).toHaveLength(1);
  });

  it('keeps the organization landing when the membership list does not contain it', async () => {
    // Access is decided by the organization's own queries. A list without the
    // organization is not a denial: a Kilo admin, or a parent owner opening a
    // child organization, is absent from it and still reaches the landing.
    roles = [];
    configData.isEnabled = true;
    const root = await mount('org_123');
    await advanceBy();
    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(0);
    expect(host(root, 'DashboardScreen')).toHaveLength(1);
  });

  it('keeps the load-error screen for the personal scope when its procedures fail', async () => {
    deniedProcedures = new Set(['getPermissionStatus', 'getConfig', 'getRepositories']);
    const root = await mount('personal');
    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(0);
    expect(host(root, 'PlatformErrorScreen')).toHaveLength(1);
  });

  it('treats a session-level unauthorized response as a load failure, not as lost access', async () => {
    sessionAuthRequired = true;
    deniedProcedures = new Set(['getPermissionStatus', 'getConfig', 'getRepositories']);
    const root = await mount('org_123');
    expect(host(root, 'ScopeAccessDeniedScreen')).toHaveLength(0);
    expect(host(root, 'PlatformErrorScreen')).toHaveLength(1);
  });
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
      configData.selectedRepositoryIds = [...selected];
      repositoriesData = [...expected.repos];
      onlineManager.setOnline(false);
      const root = await mount('personal', Screen);
      await retry(root);
      expect(host(root, 'CenteredState')).toHaveLength(0);
      expect(host(root, 'TabScreenScrollView')).toHaveLength(1);
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
        'Security Agent is disabled. Only organization owners, admins, and billing managers can turn it on.'
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
    void (async () => {
      try {
        await queryClient.query(other);
      } catch {
        // Offline: the fetch stays paused for the retry path.
      }
    })();
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
