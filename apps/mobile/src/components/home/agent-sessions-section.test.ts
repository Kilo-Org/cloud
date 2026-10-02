import { type ComponentProps, createElement } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AgentSessionsSection } from '@/components/home/agent-sessions-section';
import { LiveNowCard } from '@/components/home/live-now-card';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());
const sessionDestination = vi.hoisted(() => ({ id: '' }));
const connectivity = vi.hoisted(() => ({ offline: false }));
const queryClient = new ReactQuery.QueryClient();
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', Platform: { OS: 'ios' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => queryClient,
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/components/ui/session-status-icon', () => ({ SessionStatusIcon: 'SessionStatusIcon' }));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: () => null }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedSoft: '#777777' }),
}));
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
function session(id: string, status = 'running'): ActiveSession {
  return { id, status, title: id, connectionId: 'c1' };
}
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function nodes(type: string) {
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findAll(
    candidate => typeof candidate.type === 'string' && candidate.type === type
  );
}
function cards() {
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findAll(candidate => candidate.type === LiveNowCard);
}
function node(type: string, index = 0) {
  const result = nodes(type)[index];
  if (!result) {
    throw new Error(`Missing ${type}`);
  }
  return result;
}
function text() {
  return nodes('Text')
    .map(item => item.children.filter(child => typeof child === 'string').join(''))
    .join('\n');
}
async function render(sessions = settled, contextOverride = context) {
  await act(async () => {
    const tree = createElement(AgentSessionsSection, { context: contextOverride, sessions });
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
  it('renders one summary card and opens the highest-ranked session', async () => {
    await render({
      ...settled,
      activeSessions: [session('a3'), session('a1'), session('a2', 'question')],
    });
    expect(cards()).toHaveLength(1);
    // Ack-resolved ranked counts, zeros dropped: needs-input then working.
    expect(nodes('SessionStatusIcon').map(icon => icon.props.kind)).toEqual([
      'needsInput',
      'running',
    ]);
    expect(text()).toContain('Needs input');
    expect(text()).toContain('Working');
    // The newest-session line names the newest tray row.
    expect(text()).toContain('Newest: a3');

    const card = node('Pressable');
    (card.props.onPress as () => void)();
    expect(sessionDestination.id).toBe('a2');
  });

  it('summarises every session without capping at three rows', async () => {
    await render({
      ...settled,
      activeSessions: ['a3', 'a1', 'a4', 'a2'].map(id => session(id)),
    });
    expect(text()).toContain('4');
    expect(nodes('SessionStatusIcon')).toHaveLength(1);
  });

  it('keeps the card identity while refreshing cached content', async () => {
    const sessions = { ...settled, activeSessions: [session('a1')] };
    await render(sessions);
    const card = cards()[0];
    await render({ ...sessions, isFetching: true });
    expect(cards()[0]).toBe(card);
    expect(nodes('Skeleton')).toHaveLength(0);
    (node('Pressable').props.onPress as () => void)();
    expect(sessionDestination.id).toBe('a1');
  });

  it('renders the pending state as a card-shaped skeleton inside the reserved frame', async () => {
    await render({ ...settled, hasAcceptedSuccess: false }, { ...context, isResolving: true });
    expect(nodes('Skeleton')).toHaveLength(2);
    expect(
      nodes('Skeleton').some(skeleton => String(skeleton.props.className ?? '').includes('w-full'))
    ).toBe(false);
    expect(
      nodes('View').some(view => {
        const className = String(view.props.className ?? '');
        return className.includes('min-h-[72px]') && className.includes('rounded-2xl');
      })
    ).toBe(true);
    expect(nodes('Text').some(item => item.children.includes(i18n.t('home.noLiveSessions')))).toBe(
      false
    );
  });

  it('swaps the pending skeleton for the summary card on one reserved frame', async () => {
    await render({ ...settled, activeSessions: [session('a1')] });
    const cardFrame = String(
      nodes('View').find(view => String(view.props.className ?? '').includes('min-h-[72px]'))?.props
        .className
    );
    expect(cardFrame).toContain('min-h-[72px]');

    await render({ ...settled, hasAcceptedSuccess: false }, { ...context, isResolving: true });
    const pendingFrame = String(
      nodes('View').find(view => String(view.props.className ?? '').includes('min-h-[72px]'))?.props
        .className
    );
    // The same reserved frame the arriving card draws: the swap cannot shift
    // the LIVE NOW block.
    expect(pendingFrame).toBe(cardFrame);
  });

  it.each([
    ['running', 'running'],
    ['idle', 'idle'],
    ['question', 'needsInput'],
  ] as const)('keeps the real %s badge when the phone disconnects', async (status, kind) => {
    const sessions = { ...settled, activeSessions: [session('a1', status)] };
    await render(sessions);
    connectivity.offline = true;
    await render(sessions);
    expect(node('SessionStatusIcon').props.kind).toBe(kind);
    expect(nodes('Text').some(item => item.children.includes('No internet connection'))).toBe(true);
  });

  it('renders no live-sessions header when the accepted live list is empty', async () => {
    await render();
    expect(nodes('SectionHeader')).toHaveLength(0);
    expect(cards()).toHaveLength(0);
    expect(nodes('Text').some(item => item.children.includes('Nothing running right now'))).toBe(
      true
    );
  });

  it('switches to the Agents index and dismisses the history subpage', async () => {
    await render({ ...settled, activeSessions: [session('a1')] });
    (node('SectionHeader').props.onActionPress as () => void)();
    expect(navigateSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/');
    expect(dismissToSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/');
    expect(navigateSpy.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      dismissToSpy.mock.invocationCallOrder[0] ?? 0
    );
  });
});
