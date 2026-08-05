// Mint-gating contract: a C1 install-state token is a bearer credential and
// must only be minted when the entry view needs a fresh GitHub install URL —
// `connect-github` always, `reauthorize` only when the server offered no
// reauthorize URL. Dashboard and disabled-settings mounts must not mint.
//
// The screen is rendered as a plain function call (the same pattern used by
// `pr-review-screen.test.tsx`) with React hooks stubbed so the render is a
// no-op, and `useEffect` is stubbed to run its effect immediately so the
// `shouldMint` gate can be asserted through the `mintInstallState` mutation.

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScopeEntryScreen } from './scope-entry-screen';

const mintMutate = vi.hoisted(() => vi.fn());

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useEffect: vi.fn((effect: React.EffectCallback) => {
      effect();
    }),
  };
});

const hooks = vi.hoisted(() => ({
  permission: {
    isLoading: false,
    isError: false,
    isFetching: false,
    data: {
      hasIntegration: false,
      hasPermissions: false,
      reauthorizeUrl: null as string | null,
    },
    refetch: vi.fn(),
  },
  config: {
    isLoading: false,
    isError: false,
    isFetching: false,
    data: { isEnabled: false },
    refetch: vi.fn(),
  },
  repositories: {
    data: [] as unknown[],
    refetch: vi.fn(),
  },
  capability: {
    canManage: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentPermissionStatus: () => hooks.permission,
  useSecurityAgentConfig: () => hooks.config,
  useSecurityAgentRepositories: () => hooks.repositories,
  useSecurityAgentCapability: () => hooks.capability,
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    githubApps: {
      mintInstallState: {
        mutate: mintMutate,
      },
    },
  },
}));

vi.mock('@/lib/agent-github-integration', () => ({
  getGitHubIntegrationUrl: () => 'https://github.com/apps/kilo/installations/new',
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
}));

vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: () => null,
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: () => null,
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: () => null,
}));
vi.mock('@/components/security-agent/dashboard-screen', () => ({
  DashboardScreen: () => null,
}));
vi.mock('@/components/security-agent/security-agent-setup', () => ({
  SecurityAgentSetup: () => null,
}));
vi.mock('@/components/security-agent/settings-overview-screen', () => ({
  SettingsOverviewScreen: () => null,
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => null,
}));

type PermissionData = {
  hasIntegration: boolean;
  hasPermissions: boolean;
  reauthorizeUrl: string | null;
};

function setView(data: { permission: PermissionData; isEnabled: boolean }): void {
  hooks.permission.data = data.permission;
  hooks.config.data = { isEnabled: data.isEnabled };
}

function renderScopeEntryScreen(): void {
  // eslint-disable-next-line new-cap -- called as a plain function, matching pr-review-screen.test.tsx
  ScopeEntryScreen({ scope: 'personal' });
}

describe('ScopeEntryScreen mint gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.permission.data = {
      hasIntegration: false,
      hasPermissions: false,
      reauthorizeUrl: null,
    };
    hooks.config.data = { isEnabled: false };
  });

  it('mints a fresh URL when the connect-github view mounts', () => {
    setView({
      permission: { hasIntegration: false, hasPermissions: false, reauthorizeUrl: null },
      isEnabled: false,
    });

    renderScopeEntryScreen();

    expect(mintMutate).toHaveBeenCalledTimes(1);
    expect(mintMutate).toHaveBeenCalledWith({
      organizationId: undefined,
      returnTo: '/cloud/sessions',
    });
  });

  it('mints when reauthorize has no server-provided reauthorize URL', () => {
    setView({
      permission: { hasIntegration: true, hasPermissions: false, reauthorizeUrl: null },
      isEnabled: false,
    });

    renderScopeEntryScreen();

    expect(mintMutate).toHaveBeenCalledTimes(1);
  });

  it('does not mint when reauthorize already has a server-provided reauthorize URL', () => {
    setView({
      permission: {
        hasIntegration: true,
        hasPermissions: false,
        reauthorizeUrl: 'https://github.com/apps/kilo/installations/123',
      },
      isEnabled: false,
    });

    renderScopeEntryScreen();

    expect(mintMutate).not.toHaveBeenCalled();
  });

  it('does not mint on a dashboard mount (agent enabled)', () => {
    setView({
      permission: { hasIntegration: true, hasPermissions: true, reauthorizeUrl: null },
      isEnabled: true,
    });

    renderScopeEntryScreen();

    expect(mintMutate).not.toHaveBeenCalled();
  });

  it('does not mint on a disabled-settings mount (connected but disabled)', () => {
    setView({
      permission: { hasIntegration: true, hasPermissions: true, reauthorizeUrl: null },
      isEnabled: false,
    });

    renderScopeEntryScreen();

    expect(mintMutate).not.toHaveBeenCalled();
  });
});
