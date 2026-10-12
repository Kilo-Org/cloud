/* eslint-disable max-lines -- one suite covering every Home live state: pending, card, zero state, and header notices */
import { type ComponentProps, createElement, type ReactNode } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AgentSessionsSection } from '@/components/home/agent-sessions-section';
import { formatScheduledWake } from '@/components/agents/session-list-helpers';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());
const sessionDestination = vi.hoisted(() => ({ id: '' }));
const connectivity = vi.hoisted(() => ({ offline: false }));
const queryClient = new ReactQuery.QueryClient();
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy }),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  LinearTransition: {},
  FadeIn: { duration: () => ({}) },
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
  selectReducedMotionEntrance: (_reduced: boolean, crossfade: unknown) => crossfade,
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
}));
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
  useThemeColors: () => ({ mutedSoft: '#777777', warn: '#ff9900', good: '#22aa22' }),
}));
vi.mock('@/components/rename-modal', () => ({ RenameModal: () => null }));
vi.mock('@/components/agents/session-platform-icon', () => ({
  selectRowPlatformPresentation: () => ({ iconKind: null, spokenPlatform: null }),
  SessionPlatformIcon: () => null,
}));
vi.mock('@/components/agents/session-row-actions', () => ({
  buildSessionActionMenuItems: vi.fn(),
  useSessionDeleteConfirm: () => ({ confirmDelete: vi.fn(), deleteDialog: null }),
}));
vi.mock('@/components/agents/remote-session-exit-alert', () => ({
  useRemoteSessionExitConfirmation: () => ({
    confirmExit: vi.fn().mockResolvedValue(true),
    exitDialog: null,
  }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/components/ui/agent-badge', () => ({ AgentBadge: 'AgentBadge' }));
vi.mock('@/components/ui/session-status-icon', () => ({ SessionStatusIcon: 'SessionStatusIcon' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
// A host element that still renders the header notice. The factory is hoisted
// above the static imports, so it loads React itself.
vi.mock('@/components/home/section-header', async () => {
  const { createElement: create } = await import('react');
  return {
    SectionHeader: (props: { notice?: ReactNode }) => create('SectionHeader', props, props.notice),
  };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: () => null }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
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
function session(
  id: string,
  status = 'running',
  extra: Partial<ActiveSession> = {}
): ActiveSession {
  return { id, status, title: id, connectionId: 'c1', ...extra };
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
function node(type: string, index = 0) {
  const result = nodes(type)[index];
  if (!result) {
    throw new Error(`Missing ${type}`);
  }
  return result;
}
function text() {
  return nodes('Text')
    .map(textNode => textNode.children.filter(child => typeof child === 'string').join(''))
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

function newestButton() {
  const button = nodes('Pressable').find(
    candidate => candidate.props.accessibilityRole === 'button'
  );
  if (!button) {
    throw new Error('Missing newest session button');
  }
  return button;
}

describe('Home live section', () => {
  it('draws the four ranked state counts with the shared state dots', async () => {
    await render({
      ...settled,
      activeSessions: [
        session('need', 'question'),
        session('work', 'busy'),
        session('idle', 'idle'),
        session('later', 'scheduled', { scheduledAt: '2026-10-03T09:00:00.000Z' }),
      ],
    });
    expect(
      nodes('SessionStatusIcon')
        .map(icon => icon.props.kind)
        .slice(0, 4)
    ).toEqual(['needsInput', 'running', 'scheduled', 'idle']);
    for (const label of ['Needs input', 'Working', 'Scheduled', 'Idle']) {
      expect(text()).toContain(label);
    }
    // The soonest scheduled wake rides the scheduled row.
    expect(text()).toContain(formatScheduledWake('2026-10-03T09:00:00.000Z') ?? '');
  });

  it('shows the newest session with its state and relative age and opens it', async () => {
    await render({
      ...settled,
      activeSessions: [
        session('older', 'idle', { statusUpdatedAt: '2026-10-02T09:00:00.000Z' }),
        session('newer', 'running', { statusUpdatedAt: new Date().toISOString() }),
      ],
    });
    expect(text()).toContain('newer');
    expect(text()).toContain('Working');
    expect(text()).toContain('Just now');
    expect(newestButton().props.accessibilityLabel).toBe('newer, Working, Just now');
    (newestButton().props.onPress as () => void)();
    expect(sessionDestination.id).toBe('newer');
  });

  it('never leaves the newest block blank while a session is live', async () => {
    // No row carries a status time and the only title is the backend
    // placeholder: the block still names the session, as the list rows do.
    await render({
      ...settled,
      activeSessions: [
        session('fresh', 'busy', { title: 'New session - 2026-10-04T08:00:00.000Z' }),
      ],
    });
    expect(text()).toContain(i18n.t('agents.sessionRow.untitled'));
    expect(text()).toContain('Working');
    expect(text()).not.toContain('2026-10-04');
    (newestButton().props.onPress as () => void)();
    expect(sessionDestination.id).toBe('fresh');
  });

  it('keeps See all navigation to the Agents live index', async () => {
    await render({ ...settled, activeSessions: [session('a1')] });
    expect(node('SectionHeader').props.label).toBe(i18n.t('home.agentSessions'));
    (node('SectionHeader').props.onActionPress as () => void)();
    expect(navigateSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/');
    expect(dismissToSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/');
    expect(navigateSpy.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      dismissToSpy.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('shows a skeleton until the live list resolves', async () => {
    await render({ ...settled, hasAcceptedSuccess: false }, { ...context, isResolving: true });
    expect(nodes('Skeleton').length).toBeGreaterThan(0);
    expect(text()).not.toContain(i18n.t('home.noLiveSessions'));

    await render({ ...settled, activeSessions: [session('a1')] });
    expect(nodes('Skeleton')).toHaveLength(0);
    expect(text()).toContain('a1');
  });

  it('draws the zero state in the loaded card frame when the accepted live list is empty', async () => {
    await render();
    for (const label of ['Needs input', 'Working', 'Scheduled', 'Idle']) {
      expect(text()).toContain(`0\n${label}`);
    }
    expect(text()).toContain(i18n.t('home.noLiveSessions'));
    // Nothing to open: the newest block is not a button.
    expect(
      nodes('Pressable').some(pressable => pressable.props.accessibilityRole === 'button')
    ).toBe(false);
    // The header keeps See all's box but hides it.
    expect(node('SectionHeader').props.label).toBe(i18n.t('home.agentSessions'));
    expect(node('SectionHeader').props.actionHidden).toBe(true);
  });

  it('moves the offline notice into the header and keeps the card in place', async () => {
    const sessions = {
      ...settled,
      activeSessions: [session('a1', 'running', { statusUpdatedAt: new Date().toISOString() })],
    };
    // The header's own views (the notice's status dot) are not the section body.
    const bodyClasses = () => {
      const header = new Set(
        node('SectionHeader').findAll(candidate => Object.is(candidate.type, 'View'))
      );
      return nodes('View')
        .filter(candidate => !header.has(candidate))
        .map(candidate => String(candidate.props.className ?? ''));
    };
    await render(sessions);
    const before = bodyClasses();
    const newest = newestButton();
    connectivity.offline = true;
    await render(sessions);
    // No view joins the section body: the notice lives in the header row.
    expect(bodyClasses()).toEqual(before);
    expect(newestButton()).toBe(newest);
    // The notice renders inside the header row, not in the section body.
    expect(text()).toContain('No internet connection');
    expect(
      node('SectionHeader').findAll(candidate =>
        candidate.children.includes('No internet connection')
      )
    ).not.toHaveLength(0);
  });
});
