import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, type TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import zhHans from '@/i18n/locales/zh-Hans.json';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { renderWithProviders } from '@/test/render-with-providers';
import { ScopeEntryScreen } from './scope-entry-screen';
import { securityConfigFixture } from './security-config.test-fixture';

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);
let queryClient = new QueryClient();
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

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
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: () => undefined,
}));
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

function procedureFor(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input).pathname.split('.').at(-1) ?? '';
}
/** Host components are stubbed with their display name, so the type test is by name. */
function hostDescription(root: TestRenderer.ReactTestInstance, type: string) {
  const node = root.findAll(candidate => (candidate.type as unknown) === type)[0];
  return node?.props.description as string | undefined;
}
async function mountReauthorize() {
  const mounted = await renderWithProviders(
    createElement(TRPCProvider, {
      trpcClient,
      queryClient,
      // eslint-disable-next-line react/no-children-prop -- tRPC requires this prop in createElement calls without JSX.
      children: createElement(ScopeEntryScreen, { scope: 'personal' }),
    }),
    { queryClient }
  );
  renderer = mounted.renderer;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  return renderer.root;
}

// The reauthorize view is the only screen that renders this copy, and it is
// reached only when a connected GitHub App lost permissions — the fixture data
// below stands in for that state so the test can observe the rendered string.
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  onlineManager.setOnline(true);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  transport.mockReset().mockImplementation(async input => {
    await Promise.resolve();
    const data: Record<string, unknown> = {
      getPermissionStatus: {
        hasIntegration: true,
        hasPermissions: false,
        integrationId: 'int_fixture',
        reauthorizeUrl: 'fixture-github-install-link',
        authInvalidAt: null,
        authInvalidReason: null,
      },
      getConfig: structuredClone(securityConfigFixture),
      getRepositories: [],
      list: [],
      mintInstallState: { token: 'install-state' },
    };
    return Response.json({ result: { data: data[procedureFor(input)] } });
  });
});
afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = undefined;
  queryClient.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  await i18n.changeLanguage('en');
});

describe('ScopeEntryScreen reauthorize description', () => {
  it('renders the English source in English', async () => {
    await i18n.changeLanguage('en');
    const root = await mountReauthorize();
    expect(hostDescription(root, 'SecurityAgentSetup')).toBe(
      en.securityAgent.scopeEntry.reauthorizeDescription
    );
  });

  it.each([
    { tag: 'zh-Hans', expected: zhHans.securityAgent.scopeEntry.reauthorizeDescription },
    { tag: 'ar', expected: ar.securityAgent.scopeEntry.reauthorizeDescription },
  ])(
    'renders the $tag catalog copy instead of falling back to English',
    async ({ tag, expected }) => {
      await i18n.changeLanguage(tag);
      const rendered = hostDescription(await mountReauthorize(), 'SecurityAgentSetup');
      expect(rendered).toBe(expected);
      expect(rendered).not.toBe(en.securityAgent.scopeEntry.reauthorizeDescription);
    }
  );
});
