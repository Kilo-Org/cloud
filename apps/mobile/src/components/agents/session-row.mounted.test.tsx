/* eslint-disable max-lines -- one cohesive mounted suite: stored row, share list, and remote row share the mock harness; test-renderer mounts the real rows and their native presentation without a DOM. */
import { createElement, type ReactElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as Haptics from 'expo-haptics';

import { makeCached } from '@/lib/active-sessions-live-sync.test-helpers';
import { ShareDestinationList } from '@/components/share/share-destination-list';
import { type ShareDestinationRow } from '@/components/share/share-destinations';
import { prefetchSessionTranscript } from '@/lib/agent-session-cache';
import { createKiloAppQueryClient } from '@/lib/query-client';
import { i18n } from '@/i18n';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { __resetSessionAttentionForTests } from '@/lib/session-attention';
import { RemoteSessionRow } from './remote-session-row';
import {
  closeSessionPreviewStore,
  getSessionPreviewSnapshot,
  releaseSessionPreviewStore,
} from './session-preview-state';
import { StoredSessionRow } from './session-row';

// The share destination list renders through FlashList v2; the stub feeds the
// real `renderItem` every row, exactly as the old react-native FlatList stub did.
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
  }: {
    data: ShareDestinationRow[];
    renderItem: (info: { item: ShareDestinationRow }) => ReactElement;
  }) =>
    createElement(
      'FlashList',
      null,
      data.map(item => createElement('Cell', { key: item.session_id }, renderItem({ item })))
    ),
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  Platform: { OS: 'ios' },
}));
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
vi.mock('@/components/ui/session-status-icon', () => ({ SessionStatusIcon: 'SessionStatusIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/destination-option-row', () => ({
  DestinationOptionRow: 'DestinationOptionRow',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/agent-session-cache', () => ({
  prefetchSessionTranscript: vi.fn(),
}));
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
      },
    },
    cliSessionsV2: {
      getSessionMessages: {
        queryOptions: (input: { session_id: string }) => ({
          queryKey: ['transcript', input.session_id],
        }),
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ sendCommand: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-session-mutations', () => ({
  useSessionMutations: () => ({ renameSession: vi.fn() }),
}));
vi.mock('./exit-remote-session-from-list', () => ({
  exitRemoteSessionFromList: vi.fn(),
}));
vi.mock('./remote-session-exit-alert', () => ({
  showRemoteSessionExitConfirmation: vi.fn().mockResolvedValue(true),
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
const previewQueryClient: QueryClient = createKiloAppQueryClient();

function wrapped(ui: ReactElement): ReactElement {
  return createElement(QueryClientProvider, { client: previewQueryClient }, ui);
}

function mount(ui: ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(wrapped(ui));
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

  it('paints the untitled label for a session that still carries the backend placeholder', () => {
    // The backend seeds a fresh session with `New session - ${ISO}`; the row
    // shows its own label instead of the machine string.
    const renderer = mount(
      row({ session: { ...session, title: 'New session - 2026-09-22T01:09:45.623Z' } })
    );
    expect(texts(renderer)).toContain('Untitled session');
    expect(texts(renderer)).not.toContain('New session - 2026-09-22T01:09:45.623Z');
  });

  it('updates the dot and speech in place while retaining metadata and provenance', () => {
    const props = { session: { ...session, associatedPr: { number: 42 } }, metaWhileLive: true };
    const renderer = mount(row(props));
    const button = hosts(renderer, 'Pressable')[0];
    const nonliveLabel =
      'Fix login bug, feature/live, pull request 42, CLI, and cost 12 cents, 5 minutes ago';
    expect(button?.props.accessibilityLabel).toBe(nonliveLabel);
    expect(hosts(renderer, 'SessionStatusIcon')).toHaveLength(0);
    expect(texts(renderer)).toContain('$0.12 · 5 MINUTES AGO');

    act(() => {
      renderer.update(wrapped(row({ ...props, live: true })));
    });
    expect(hosts(renderer, 'Pressable')[0]).toBe(button);
    expect(button?.props.accessibilityLabel).toBe(
      'Fix login bug, LIVE, feature/live, pull request 42, CLI, and cost 12 cents, 5 minutes ago'
    );
    expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'running' },
    ]);
    expect(texts(renderer)).toContain('$0.12 · 5 MINUTES AGO');
    expect(texts(renderer)).toContain('feature/live · #42');

    act(() => {
      renderer.update(wrapped(row({ ...props, live: false })));
    });
    expect(button?.props.accessibilityLabel).toBe(nonliveLabel);
    expect(hosts(renderer, 'SessionStatusIcon')).toHaveLength(0);
  });

  it('keeps the live eyebrow to the status glyph alone (no platform mark beside it)', () => {
    // A platform glyph beside the status mark reads as a stray second mark
    // crowding the meta, so a live row draws the status glyph only. The
    // stored (non-live) row keeps its platform mark.
    const withRepo = { ...session, git_url: 'git@github.com:org/my-repo.git' };
    const liveRenderer = mount(row({ session: withRepo, live: true, metaWhileLive: true }));
    expect(liveRenderer.root.findAllByProps({ testID: 'platform-icon-terminal' })).toHaveLength(0);
    expect(hosts(liveRenderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'running' },
    ]);
    expect(hosts(liveRenderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Fix login bug, LIVE, feature/live, MY-REPO, and cost 12 cents, 5 minutes ago'
    );

    const storedRenderer = mount(row({ session: withRepo, live: false }));
    expect(storedRenderer.root.findAllByProps({ testID: 'platform-icon-terminal' })).toHaveLength(
      1
    );
    expect(hosts(storedRenderer, 'SessionStatusIcon')).toHaveLength(0);
    expect(hosts(storedRenderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Fix login bug, feature/live, MY-REPO, cost 12 cents, 5 minutes ago, and from CLI'
    );
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
      'Fix login bug, EN DIRECTO, CLI y hace 5 minutos'
    );
    expect(texts(renderer)).toContain('HACE 5 MINUTOS');
    expect(hosts(renderer, 'SessionStatusIcon')).toHaveLength(1);
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
      expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
        { kind: 'needsInput' },
      ]);
      expect(texts(renderer)).toContain('NEEDS INPUT');
      expect(texts(renderer)).not.toContain('$0.12 · 5 MINUTES AGO');
    }
  );

  it.each(['New session - 2026-09-22T02:05:22.778Z', 'Child session - 2026-09-22T02:05:22.778Z'])(
    'paints the localized unnamed name instead of the backend placeholder %s',
    placeholder => {
      const renderer = mount(row({ session: { ...session, title: placeholder } }));
      expect(texts(renderer)).toContain('Untitled session');
      expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toContain(
        'Untitled session'
      );
      expect(texts(renderer)).not.toContain(placeholder);
    }
  );

  it('keeps a real server title on the row', () => {
    const renderer = mount(row({ session: { ...session, title: 'Verifier Rename Check' } }));
    expect(texts(renderer)).toContain('Verifier Rename Check');
  });

  it('does not prefetch a transcript for a row without preview actions', () => {
    vi.mocked(prefetchSessionTranscript).mockClear();
    const renderer = mount(
      row({ interactive: false, onDelete: () => undefined, onRename: () => undefined })
    );
    const button = hosts(renderer, 'Pressable')[0];
    expect(button?.props.onLongPress).toBeUndefined();
    act(() => {
      (button?.props as { onPressIn?: () => void } | undefined)?.onPressIn?.();
    });
    expect(prefetchSessionTranscript).not.toHaveBeenCalled();
  });

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
      expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
        { kind: 'running' },
      ]);
      expect(button.props.onLongPress).toBeUndefined();
      const { onPress } = button.props as Pick<Parameters<typeof StoredSessionRow>[0], 'onPress'>;
      act(onPress);
      expect(selectedId).toBe(destinationsDisabled ? null : 'stored-1');
    }
  );

  it('shows the untitled fallback for a creation placeholder title and never speaks the ISO instant', () => {
    const renderer = mount(
      row({
        session: {
          ...session,
          title: 'New session - 2026-09-22T17:26:31.465Z',
          git_branch: null,
          total_cost_microdollars: null,
        },
      })
    );
    expect(texts(renderer)).toContain(i18n.t('agents.sessionRow.untitled'));
    const button = hosts(renderer, 'Pressable')[0];
    expect(button?.props.accessibilityLabel).toContain(i18n.t('agents.sessionRow.untitled'));
    expect(button?.props.accessibilityLabel).not.toContain('2026-09-22');
  });

  const placeholderTitle = 'New session - 2026-09-21T15:44:47.176Z';

  it('renders the generic untitled label for the server creation-default title', () => {
    const renderer = mount(row({ session: { ...session, title: placeholderTitle } }));
    expect(texts(renderer)).toContain('Untitled session');
    expect(texts(renderer)).not.toContain(placeholderTitle);
    const button = hosts(renderer, 'Pressable')[0];
    expect(button?.props.accessibilityLabel).toContain('Untitled session');
    expect(button?.props.accessibilityLabel).not.toContain('2026-09-21');
  });

  it('passes a blank rename value for the server creation-default title', () => {
    const renderer = mount(
      row({
        session: { ...session, title: placeholderTitle },
        onRename: () => undefined,
        onDelete: () => undefined,
      })
    );
    const button = hosts(renderer, 'Pressable')[0];
    if (!button) {
      throw new Error('Missing row button');
    }
    act(() => {
      (button.props as { onLongPress?: () => void }).onLongPress?.();
    });
    expect(getSessionPreviewSnapshot().target?.initialRenameValue).toBe('');
    act(() => {
      closeSessionPreviewStore();
      releaseSessionPreviewStore();
    });
  });

  it('keeps a real title that merely starts with "New session"', () => {
    const renderer = mount(
      row({ session: { ...session, title: 'New session plan for the login redirect' } })
    );
    expect(texts(renderer)).toContain('New session plan for the login redirect');
  });
});

describe('StoredSessionRow long-press preview', () => {
  const onDelete = vi.fn<() => void>();
  const onRename = vi.fn<(newTitle: string) => void>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetSessionAttentionForTests();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-28T12:00:00.000Z'));
    vi.mocked(Haptics.impactAsync).mockClear();
    vi.mocked(prefetchSessionTranscript).mockClear();
    onDelete.mockClear();
    onRename.mockClear();
    closeSessionPreviewStore();
    releaseSessionPreviewStore();
  });
  afterEach(async () => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount();
      }
    });
    mounted.length = 0;
    closeSessionPreviewStore();
    releaseSessionPreviewStore();
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  function managedRow(overrides: Partial<Parameters<typeof StoredSessionRow>[0]> = {}) {
    return row({ onDelete, onRename, ...overrides });
  }

  function pressableProps(renderer: TestRenderer.ReactTestRenderer) {
    return hosts(renderer, 'Pressable')[0]?.props as
      | {
          onPress?: () => void;
          onPressIn?: () => void;
          onLongPress?: () => void;
          onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
          accessibilityActions?: { name: string; label: string }[];
        }
      | undefined;
  }

  it('writes the row session into the store and does not fire a haptic', () => {
    const renderer = mount(managedRow());
    act(() => {
      pressableProps(renderer)?.onLongPress?.();
    });
    const snapshot = getSessionPreviewSnapshot();
    expect(snapshot.visible).toBe(true);
    expect(snapshot.target).toMatchObject({
      sessionId: 'stored-1',
      title: 'Fix login bug',
      initialRenameValue: 'Fix login bug',
      live: false,
      statusKind: null,
      needsInput: false,
      totalCostMicrodollars: 120_000,
      onRename,
      onDelete,
    });
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(hosts(renderer, 'RenameModal')).toHaveLength(0);
  });

  it('still fires onPress', () => {
    const onPress = vi.fn<() => void>();
    const renderer = mount(managedRow({ onPress }));
    act(() => {
      pressableProps(renderer)?.onPress?.();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(getSessionPreviewSnapshot().target).toBeNull();
  });

  it('prefetches the transcript query options on press-in', () => {
    const renderer = mount(managedRow());
    act(() => {
      pressableProps(renderer)?.onPressIn?.();
    });
    expect(prefetchSessionTranscript).toHaveBeenCalledWith(previewQueryClient, {
      queryKey: ['transcript', 'stored-1'],
    });
  });

  it('opens the preview from the rotor manage action', () => {
    const renderer = mount(managedRow());
    const props = pressableProps(renderer);
    expect(props?.accessibilityActions).toEqual([{ name: 'manage', label: 'Session actions' }]);
    act(() => {
      props?.onAccessibilityAction?.({ nativeEvent: { actionName: 'manage' } });
    });
    expect(getSessionPreviewSnapshot().target?.sessionId).toBe('stored-1');
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it('seeds initialRenameValue empty for a session the backend has not named', () => {
    const renderer = mount(
      managedRow({ session: { ...session, title: 'New session - 2026-09-20T08:10:35.172Z' } })
    );
    act(() => {
      pressableProps(renderer)?.onLongPress?.();
    });
    expect(getSessionPreviewSnapshot().target).toMatchObject({
      title: 'Untitled session',
      initialRenameValue: '',
    });
  });

  it('seeds initialRenameValue with the trimmed stored title for a named session', () => {
    const renderer = mount(managedRow({ session: { ...session, title: '  Fix login bug  ' } }));
    act(() => {
      pressableProps(renderer)?.onLongPress?.();
    });
    expect(getSessionPreviewSnapshot().target?.initialRenameValue).toBe('Fix login bug');
  });

  it('forwards live and statusKind the same way the row paints them', () => {
    const renderer = mount(managedRow({ live: true, session: { ...session, status: 'question' } }));
    act(() => {
      pressableProps(renderer)?.onLongPress?.();
    });
    expect(getSessionPreviewSnapshot().target).toMatchObject({
      live: true,
      statusKind: 'needsInput',
      needsInput: true,
    });
  });
});

describe('RemoteSessionRow live speech', () => {
  let client: QueryClient = createKiloAppQueryClient();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetSessionAttentionForTests();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-28T12:00:00.000Z'));
    client = createKiloAppQueryClient();
    client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
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

  function mountRemote(overrides: Partial<ActiveSession> = {}) {
    return mount(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RemoteSessionRow, {
          session: {
            ...makeCached({
              id: 'remote-1',
              status: 'busy',
              title: 'Live work',
              createdOnPlatform: 'cli',
              gitBranch: 'feature/live',
              updatedAt: '2026-08-28T11:55:00.000Z',
            }),
            ...overrides,
          },
          onPress: () => undefined,
        })
      )
    );
  }

  it('speaks Working for a working row, drawn and spoken from one derivation', () => {
    const renderer = mountRemote();
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Live work, Working, feature/live, CLI, and 5 minutes ago'
    );
    expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'running' },
    ]);
    expect(texts(renderer)).toContain('5 MINUTES AGO');
    expect(texts(renderer)).toContain('feature/live');
  });

  it('paints the localized unnamed name instead of the backend placeholder title', () => {
    const renderer = mountRemote({ title: 'New session - 2026-09-22T02:05:22.778Z' });
    expect(texts(renderer)).toContain('Untitled session');
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toContain('Untitled session');
    expect(texts(renderer)).not.toContain('New session - 2026-09-22T02:05:22.778Z');
  });

  it('speaks Idle once the agent stops working', () => {
    const renderer = mountRemote({ status: 'idle' });
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Live work, Idle, feature/live, CLI, and 5 minutes ago'
    );
    expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'idle' },
    ]);
  });

  it('keeps the needs-input speech above the state word', () => {
    const renderer = mountRemote({ status: 'question' });
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Live work, needs input, feature/live, and CLI'
    );
    expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'needsInput' },
    ]);
    expect(texts(renderer)).toContain('NEEDS INPUT');
  });

  it('speaks Working for an unrecognized status, agreeing with the drawn glyph', () => {
    const renderer = mountRemote({ status: 'mystery' });
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Live work, Working, feature/live, CLI, and 5 minutes ago'
    );
    expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'running' },
    ]);
  });

  it('draws the idle tray row with the status glyph alone (no platform mark)', () => {
    // SPOT-DEFECT (e1): the finished row's status cluster showed a stray
    // second mark beside the idle circle — the platform glyph. The tray row
    // always draws the status glyph, so the platform glyph is withheld.
    const renderer = mountRemote({
      status: 'idle',
      createdOnPlatform: 'cli',
      gitUrl: 'git@github.com:org/live-repo.git',
    });
    expect(renderer.root.findAllByProps({ testID: 'platform-icon-terminal' })).toHaveLength(0);
    expect(hosts(renderer, 'SessionStatusIcon').map(glyph => glyph.props)).toEqual([
      { kind: 'idle' },
    ]);
    expect(hosts(renderer, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Live work, Idle, feature/live, LIVE-REPO, and 5 minutes ago'
    );
  });

  it('shows the untitled fallback for a creation placeholder title and never speaks the ISO instant', () => {
    const renderer = mountRemote({ title: 'New session - 2026-09-22T17:26:31.465Z' });
    expect(texts(renderer)).toContain(i18n.t('agents.sessionRow.untitled'));
    const button = hosts(renderer, 'Pressable')[0];
    expect(button?.props.accessibilityLabel).toContain(i18n.t('agents.sessionRow.untitled'));
    expect(button?.props.accessibilityLabel).not.toContain('2026-09-22');
  });
});
