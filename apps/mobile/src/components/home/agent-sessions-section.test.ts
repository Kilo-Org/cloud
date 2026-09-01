/* eslint-disable typescript-eslint/no-deprecated -- DOM-free React Native section tests */
import { type ComponentProps, createElement } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AgentSessionsSection } from '@/components/home/agent-sessions-section';
import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());
const sessionDestination = vi.hoisted(() => ({ id: '' }));
const connectivity = vi.hoisted(() => ({ offline: false }));
const queryClient = new ReactQuery.QueryClient();
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy }),
}));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', Platform: { OS: 'ios' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => queryClient,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
      },
    },
  }),
}));
vi.mock('@/lib/hooks/use-session-mutations', () => ({
  useSessionMutations: () => ({ renameSession: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedSoft: '#777777' }),
}));
vi.mock('@/components/rename-modal', () => ({ RenameModal: () => null }));
vi.mock('@/components/agents/session-platform-icon', () => ({
  selectRowPlatformPresentation: () => ({ iconKind: null, spokenPlatform: null }),
  SessionPlatformIcon: () => null,
}));
vi.mock('@/components/agents/session-row-actions', () => ({
  copySessionId: vi.fn(),
  showRenamePrompt: vi.fn(),
  showSessionActionMenu: vi.fn(),
}));
vi.mock('@/components/agents/remote-session-exit-alert', () => ({
  showRemoteSessionExitConfirmation: vi.fn(),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/components/ui/agent-badge', () => ({ AgentBadge: 'AgentBadge' }));
vi.mock('@/components/ui/status-dot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: () => null }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({ useOrgBoundary: vi.fn() }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => (connectivity.offline ? 'offline' : 'online'),
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionHealth: () => ({
    isConnected: !connectivity.offline,
    reconnectExhausted: false,
  }),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({}),
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => (id: string) => {
    sessionDestination.id = id;
  },
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => {
    throw new Error('Home must not mount stored history');
  },
  useLiveAgentSessions: () => {
    throw new Error('The section must not mount another live query');
  },
}));

type Props = ComponentProps<typeof AgentSessionsSection>;
const context: Props['context'] = {
  organizationId: 'org-1',
  isReady: true,
  isResolving: false,
  isError: false,
  label: 'Engineering',
  refetch: vi.fn(),
};
const settled: Props['sessions'] = {
  activeSessions: [],
  hasAcceptedSuccess: true,
  terminalError: null,
  isLoading: false,
  isError: false,
  isFetching: false,
  isPaused: false,
  refetch: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
};
function session(id: string): ActiveSession {
  return { id, status: 'running', title: id, connectionId: 'c1' };
}
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function nodes(type: string) {
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findAll(
    candidate =>
      (type === 'RemoteSessionRow' && candidate.type === RemoteSessionRow) ||
      (typeof candidate.type === 'string' && candidate.type === type)
  );
}
function node(type: string, index = 0) {
  const result = nodes(type)[index];
  if (!result) {
    throw new Error(`Missing ${type}`);
  }
  return result;
}
async function render(sessions = settled) {
  await act(async () => {
    const tree = createElement(AgentSessionsSection, { context, sessions });
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
    await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  navigateSpy.mockClear();
  dismissToSpy.mockClear();
  sessionDestination.id = '';
  connectivity.offline = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  queryClient.clear();
});

describe('Home live section', () => {
  it('preserves incoming live order and caps rendered rows at three without stored queries', async () => {
    await render({ ...settled, activeSessions: ['a3', 'a1', 'a4', 'a2'].map(id => session(id)) });
    expect(nodes('RemoteSessionRow').map(row => (row.props.session as ActiveSession).id)).toEqual([
      'a3',
      'a1',
      'a4',
    ]);
    (node('RemoteSessionRow', 1).props.onPress as () => void)();
    expect(sessionDestination.id).toBe('a1');
  });

  it('keeps row identity and navigation while refreshing cached content', async () => {
    const sessions = { ...settled, activeSessions: [session('a1')] };
    await render(sessions);
    const row = node('RemoteSessionRow');
    await render({ ...sessions, isFetching: true });
    expect(node('RemoteSessionRow')).toBe(row);
    expect(nodes('Skeleton')).toHaveLength(0);
    (row.props.onPress as () => void)();
    expect(sessionDestination.id).toBe('a1');
  });

  it.each([
    ['running', 'good', false],
    ['question', 'warn', true],
  ] as const)(
    'keeps the real %s badge when the phone disconnects',
    async (status, tone, needsInput) => {
      const sessions = { ...settled, activeSessions: [{ ...session('a1'), status }] };
      await render(sessions);
      const row = node('RemoteSessionRow');
      connectivity.offline = true;
      await render(sessions);
      expect(node('RemoteSessionRow')).toBe(row);
      expect(node('StatusDot').props.tone).toBe(tone);
      expect(nodes('Text').some(text => text.children.includes('NEEDS INPUT'))).toBe(needsInput);
      expect(nodes('Text').some(text => text.children.includes('No internet connection'))).toBe(
        true
      );
    }
  );

  it('switches to the Agents index and dismisses the history subpage', async () => {
    await render();
    (node('SectionHeader').props.onActionPress as () => void)();
    expect(navigateSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/');
    expect(dismissToSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/');
    expect(navigateSpy.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      dismissToSpy.mock.invocationCallOrder[0] ?? 0
    );
  });
});
