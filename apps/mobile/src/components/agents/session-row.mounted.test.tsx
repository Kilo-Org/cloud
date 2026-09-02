/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the real stored row and its native presentation without a DOM. */
import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareDestinationList } from '@/components/share/share-destination-list';
import { type ShareDestinationRow } from '@/components/share/share-destinations';
import { i18n } from '@/i18n';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { __resetSessionAttentionForTests } from '@/lib/session-attention';
import { StoredSessionRow } from './session-row';

vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    View: 'View',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: { OS: 'ios' },
    FlatList: ({
      data,
      renderItem,
    }: {
      data: ShareDestinationRow[];
      renderItem: (info: { item: ShareDestinationRow }) => ReactElement;
    }) =>
      React.createElement(
        'FlatList',
        null,
        data.map(item =>
          React.createElement('Cell', { key: item.session_id }, renderItem({ item }))
        )
      ),
  };
});
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedSoft: '#999999', mutedForeground: '#999999' }),
}));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: vi.fn().mockResolvedValue(null),
  setItem: vi.fn().mockResolvedValue(undefined),
  clearScope: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/ui/icons', () => ({
  Cloud: 'Cloud',
  Code: 'Code',
  Terminal: 'Terminal',
  Search: 'Search',
}));
vi.mock('@/components/icons/github-icon', () => ({ GitHubIcon: 'GitHubIcon' }));
vi.mock('@/components/icons/slack-icon', () => ({ SlackIcon: 'SlackIcon' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'Chevron' }));
vi.mock('@/components/ui/agent-badge', () => ({ AgentBadge: 'AgentBadge' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/status-dot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/destination-option-row', () => ({
  DestinationOptionRow: 'DestinationOptionRow',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));
vi.mock('./session-row-actions', () => ({
  copySessionId: vi.fn(),
  showDeleteConfirm: vi.fn(),
  showRenamePrompt: vi.fn(),
  showSessionActionMenu: vi.fn(),
}));

const session: StoredSession = {
  session_id: 'stored-1',
  title: 'Fix login bug',
  organization_id: 'org-1',
  cloud_agent_session_id: null,
  cloud_agent_worktree_id: null,
  parent_session_id: null,
  created_on_platform: 'cli',
  git_url: null,
  git_branch: 'feature/live',
  status: null,
  status_updated_at: null,
  total_cost_microdollars: 120_000,
  created_at: '2026-08-28T10:00:00.000Z',
  updated_at: '2026-08-28T11:55:00.000Z',
  version: 0,
  associatedPr: null,
};
const mounted: TestRenderer.ReactTestRenderer[] = [];

function mount(ui: ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(ui);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

function isHost(node: TestRenderer.ReactTestInstance, type: string) {
  return node.type === type;
}

function hosts(renderer: TestRenderer.ReactTestRenderer, type: string) {
  return renderer.root.findAll(node => isHost(node, type));
}

function texts(renderer: TestRenderer.ReactTestRenderer) {
  return hosts(renderer, 'Text').map(node => node.props.children);
}

function row(overrides: Partial<Parameters<typeof StoredSessionRow>[0]> = {}) {
  return createElement(StoredSessionRow, {
    session,
    sortBy: 'updated_at',
    onPress: () => undefined,
    ...overrides,
  });
}

describe('StoredSessionRow live speech', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetSessionAttentionForTests();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-28T12:00:00.000Z'));
  });
  afterEach(async () => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount();
      }
    });
    mounted.length = 0;
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('updates the dot and speech in place while retaining metadata and provenance', () => {
    const props = { session: { ...session, associatedPr: { number: 42 } }, metaWhileLive: true };
    const renderer = mount(row(props));
    const button = hosts(renderer, 'Pressable')[0];
    const nonliveLabel =
      'Fix login bug, feature/live, pull request 42, CLI, and cost 12 cents, 5 minutes ago';
    expect(button?.props.accessibilityLabel).toBe(nonliveLabel);
    expect(hosts(renderer, 'StatusDot')).toHaveLength(0);
    expect(texts(renderer)).toContain('$0.12 · 5 MINUTES AGO');

    act(() => {
      renderer.update(row({ ...props, live: true }));
    });
    expect(hosts(renderer, 'Pressable')[0]).toBe(button);
    expect(button?.props.accessibilityLabel).toBe(
      'Fix login bug, LIVE, feature/live, pull request 42, CLI, and cost 12 cents, 5 minutes ago'
    );
    expect(hosts(renderer, 'StatusDot').map(dot => dot.props)).toEqual([{ tone: 'good' }]);
    expect(texts(renderer)).toContain('$0.12 · 5 MINUTES AGO');
    expect(texts(renderer)).toContain('feature/live · #42');

    act(() => {
      renderer.update(row({ ...props, live: false }));
    });
    expect(button?.props.accessibilityLabel).toBe(nonliveLabel);
    expect(hosts(renderer, 'StatusDot')).toHaveLength(0);
  });

  it('updates an existing live row to localized speech and locale-aware list composition', async () => {
    const renderer = mount(
      row({
        session: { ...session, git_branch: null, total_cost_microdollars: null },
        live: true,
        metaWhileLive: true,
      })
    );
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Fix login bug, EN VIVO, CLI y hace 5 minutos'
    );
    expect(texts(renderer)).toContain('HACE 5 MINUTOS');
    expect(hosts(renderer, 'StatusDot')).toHaveLength(1);
  });

  it.each(['question', 'permission'])(
    'keeps %s attention above live speech and metadata',
    status => {
      const renderer = mount(
        row({ session: { ...session, status }, live: true, metaWhileLive: true })
      );
      expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
        'Fix login bug, needs input, feature/live, and CLI'
      );
      expect(hosts(renderer, 'StatusDot').map(dot => dot.props)).toEqual([
        { tone: 'warn', pulse: true },
      ]);
      expect(texts(renderer)).toContain('NEEDS INPUT');
      expect(texts(renderer)).not.toContain('$0.12 · 5 MINUTES AGO');
    }
  );

  it.each([false, true])('keeps Home/card speech unchanged for live=%s', live => {
    const renderer = mount(
      row({
        session: { ...session, associatedPr: { number: 42 } },
        variant: 'card',
        interactive: false,
        live,
      })
    );
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Fix login bug, feature/live, CLI, and cost 12 cents, 5 minutes ago'
    );
    expect(texts(renderer)).toContain('feature/live');
    expect(texts(renderer)).not.toContain('feature/live · #42');
  });

  it.each([false, true])(
    'covers the actual Share live opt-in with disabled=%s',
    destinationsDisabled => {
      let selectedId: string | null = null;
      const renderer = mount(
        createElement(ShareDestinationList, {
          state: {
            kind: 'happy',
            showNewSession: true,
            showRetry: false,
            showList: true,
            listMode: 'rows',
          },
          destinations: [{ ...session, live: true }],
          destinationsDisabled,
          onSelect: selected => {
            selectedId = selected.session_id;
          },
          onRetry: () => undefined,
          instances: [],
          spawningConnectionId: null,
          instanceRowsDisabled: false,
          onSpawnInstance: () => undefined,
        })
      );
      const button = renderer.root.find(node => isHost(node, 'Pressable'));
      expect(button.props.accessibilityLabel).toBe(
        'Fix login bug, LIVE, feature/live, CLI, and cost 12 cents, 5 minutes ago'
      );
      expect(texts(renderer)).toContain('$0.12 · 5 MINUTES AGO');
      expect(hosts(renderer, 'StatusDot').map(dot => dot.props)).toEqual([{ tone: 'good' }]);
      expect(button.props.onLongPress).toBeUndefined();
      const { onPress } = button.props as Pick<Parameters<typeof StoredSessionRow>[0], 'onPress'>;
      act(onPress);
      expect(selectedId).toBe(destinationsDisabled ? null : 'stored-1');
    }
  );
});
