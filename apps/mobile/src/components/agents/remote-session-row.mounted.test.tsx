/* eslint-disable max-lines -- exit refresh, rename seed, and long-press preview share the live-sync mock harness */
import { createElement } from 'react';
import { Pressable } from 'react-native';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as Haptics from 'expo-haptics';

import { RemoteSessionRow } from './remote-session-row';
import { prefetchSessionTranscript } from '@/lib/agent-session-cache';
import {
  closeSessionPreviewStore,
  getSessionPreviewSnapshot,
  releaseSessionPreviewStore,
} from './session-preview-state';
import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  deferred,
  flushQueryUpdates as flush,
  makeCached,
  makeConnection,
  QUERY_KEY,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { createKiloAppQueryClient, getActiveSessionsQueryMetadata } from '@/lib/query-client';

const state = vi.hoisted(() => ({
  organizationId: null as string | null,
  request: vi.fn<() => Promise<CachedActiveSessionsData>>(),
  send: vi.fn(),
  renameSession: vi.fn<(id: string, title: string) => void>(),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: state.organizationId, isLoaded: true }),
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
  useUserWebConnection: () => ({ sendCommand: state.send }),
}));
vi.mock('@/lib/hooks/use-session-mutations', () => ({
  useSessionMutations: () => ({ renameSession: state.renameSession }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ mutedSoft: '#777' }) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
vi.mock('@/components/rename-modal', () => ({ RenameModal: () => null }));
vi.mock('@/components/ui/session-row', () => ({ SessionRow: 'SessionRow' }));
vi.mock('@/components/agents/session-platform-icon', () => ({
  selectRowPlatformPresentation: () => ({ iconKind: null, spokenPlatform: null }),
  SessionPlatformIcon: () => null,
}));
vi.mock('@/components/agents/remote-session-exit-alert', () => ({
  showRemoteSessionExitConfirmation: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/session-attention', () => ({
  isAttentionAcked: () => false,
  reconcileSessionAttention: vi.fn(),
  shouldShowNeedsInput: () => false,
  useSessionAttentionRevision: () => 0,
}));

let client: QueryClient = createKiloAppQueryClient();
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let owner: ActiveSessionsLiveSync | undefined = undefined;
let unsubscribe: (() => void) | undefined = undefined;
const cached = { sessions: [makeCached({ createdOnPlatform: 'cli' })] };
const otherKey = [
  ['activeSessions', 'list'],
  {
    input: { ...buildActiveSessionsTrayInput(null), includeCloudAgentSessions: false },
    type: 'query',
  },
];
const session: ActiveSession = makeCached({ createdOnPlatform: 'cli' });

async function render(row: ActiveSession = session) {
  await act(async () => {
    const tree = createElement(
      QueryClientProvider,
      { client },
      createElement(RemoteSessionRow, { session: row, onPress: vi.fn<() => void>() })
    );
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
    await flush();
  });
}
function attach(queryKey: readonly unknown[] = QUERY_KEY) {
  owner = new ActiveSessionsLiveSync({
    connection: makeConnection(),
    queryClient: client,
    queryKey,
    queryFn: state.request,
  });
  owner.attach();
}
function pressableProps() {
  if (!renderer) {
    throw new Error('Missing row');
  }
  return renderer.root.findByType(Pressable).props as {
    onPress?: () => void;
    onPressIn?: () => void;
    onLongPress?: () => void;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    accessibilityActions?: { name: string; label: string }[];
  };
}

async function exit() {
  await act(async () => {
    pressableProps().onLongPress?.();
    const onExit = getSessionPreviewSnapshot().target?.onExit;
    if (!onExit) {
      throw new Error('Missing exit action');
    }
    onExit();
    await flush();
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setSignOutActive(false);
  state.organizationId = null;
  state.request.mockReset().mockResolvedValue({ sessions: [] });
  state.send.mockReset().mockResolvedValue(undefined);
  state.renameSession.mockReset();
  vi.mocked(Haptics.impactAsync).mockClear();
  vi.mocked(prefetchSessionTranscript).mockClear();
  closeSessionPreviewStore();
  releaseSessionPreviewStore();
  client = createKiloAppQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  client.setQueryData(QUERY_KEY, cached);
  client.setQueryData(otherKey, cached);
  const observer = new QueryObserver(client, {
    queryKey: QUERY_KEY,
    queryFn: state.request,
    staleTime: Infinity,
  });
  unsubscribe = observer.subscribe(() => undefined);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    owner?.detach();
    unsubscribe?.();
    client.clear();
    await flush();
  });
  renderer = undefined;
  owner = undefined;
  unsubscribe = undefined;
  setSignOutActive(false);
  closeSessionPreviewStore();
  releaseSessionPreviewStore();
});

describe('row title', () => {
  it('paints the untitled label for a session that still carries the backend placeholder', async () => {
    // The backend seeds a fresh session with `New session - ${ISO}`; the tray
    // row shows its own label instead of the machine string. Both merge sides
    // covered this title, so the assertions live in one test: the row title and
    // the spoken label never carry the raw timestamp.
    await render({ ...session, title: 'New session - 2026-09-22T01:09:45.623Z' });
    expect(renderer?.root.findByType('SessionRow').props.title).toBe('Untitled session');
    const label = renderer?.root.findByType(Pressable).props.accessibilityLabel as string;
    expect(label).toContain('Untitled session');
    expect(label).not.toContain('2026-09-22');
  });

  it('keeps a real title unchanged', async () => {
    await render({ ...session, title: 'Live work' });
    expect(renderer?.root.findByType('SessionRow').props.title).toBe('Live work');
  });
});

describe('row exit refresh caller', () => {
  it.each(['matching', 'mismatched', 'absent'] as const)(
    'reconciles its exact query with a %s owner',
    async scope => {
      if (scope !== 'absent') {
        attach(scope === 'matching' ? QUERY_KEY : otherKey);
      }
      await render();
      await exit();
      expect(client.getQueryData(QUERY_KEY)).toEqual({ sessions: [] });
      expect(client.getQueryData(otherKey)).toEqual(cached);
      expect(
        getActiveSessionsQueryMetadata(
          client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true })
        ).acceptedRevision
      ).toBe(1);
      expect(state.send.mock.calls).toEqual([['a1', 'exit_cli', { protocolVersion: 1 }, 'c1']]);
    }
  );

  it('does not launch another refresh after a handled owner failure', async () => {
    attach();
    state.request.mockRejectedValue(new Error('offline'));
    await render();
    await exit();
    expect(client.getQueryData(QUERY_KEY)).toEqual(cached);
    expect(owner?.getPendingReasons()).toContain('manual');
    expect(state.request.mock.calls).toHaveLength(1);
  });

  it.each(['context', 'account', 'sign-out', 'reattach', 'unmount'] as const)(
    'does not reconcile a replacement scope after late %s completion',
    async change => {
      attach();
      const network = deferred<CachedActiveSessionsData>();
      state.request.mockReturnValue(network.promise);
      await render();
      await exit();
      if (change === 'context' || change === 'unmount') {
        state.organizationId = 'org-b';
      }
      if (change === 'account') {
        bumpAuthEpoch();
        client.clear();
      }
      if (change === 'sign-out') {
        setSignOutActive(true);
      }
      if (change === 'reattach') {
        owner?.detach();
        owner?.attach();
      }
      const key = [
        ['activeSessions', 'list'],
        { input: buildActiveSessionsTrayInput(state.organizationId), type: 'query' },
      ];
      const current = { sessions: [makeCached({ id: 'b', organizationId: state.organizationId })] };
      await act(async () => {
        client.setQueryData(key, current);
        await flush();
      });
      if (change === 'unmount') {
        await act(() => {
          renderer?.unmount();
        });
        renderer = undefined;
      } else {
        await render();
      }
      await act(async () => {
        network.resolve({ sessions: [] });
        await flush();
      });
      expect(client.getQueryData(key)).toEqual(current);
      expect(state.request.mock.calls).toHaveLength(1);
    }
  );

  it('skips reconciliation when the account changes before the exit acknowledgement', async () => {
    attach();
    const acknowledgement = deferred<undefined>();
    state.send.mockReturnValue(acknowledgement.promise);
    await render();
    await exit();
    bumpAuthEpoch();
    client.clear();
    const current = { sessions: [makeCached({ id: 'b' })] };
    client.setQueryData(QUERY_KEY, current);
    await render();
    await act(async () => {
      acknowledgement.resolve(undefined);
      await flush();
    });
    expect(client.getQueryData(QUERY_KEY)).toEqual(current);
    expect(state.request.mock.calls).toHaveLength(0);
  });
});

describe('RemoteSessionRow rename prefill', () => {
  it('seeds initialRenameValue empty for a session the backend has not named', async () => {
    // The row hides `New session - ${ISO}` on screen; the rename field must
    // not reopen that machine string, so an unnamed session opens blank.
    await render(
      makeCached({
        id: 'remote-rename',
        createdOnPlatform: 'cli',
        title: 'New session - 2026-09-20T08:10:35.172Z',
      })
    );
    act(() => {
      pressableProps().onLongPress?.();
    });
    expect(getSessionPreviewSnapshot().target).toMatchObject({
      sessionId: 'remote-rename',
      title: 'Untitled session',
      initialRenameValue: '',
    });
  });
});

describe('RemoteSessionRow long-press preview', () => {
  it('writes the row session into the store and does not fire a haptic', async () => {
    const onPress = vi.fn<() => void>();
    await act(async () => {
      const tree = createElement(
        QueryClientProvider,
        { client },
        createElement(RemoteSessionRow, { session, onPress })
      );
      renderer = TestRenderer.create(tree);
      await flush();
    });
    act(() => {
      pressableProps().onLongPress?.();
    });
    const snapshot = getSessionPreviewSnapshot();
    expect(snapshot.visible).toBe(true);
    expect(snapshot.target).toMatchObject({
      sessionId: 'a1',
      title: 'test',
      initialRenameValue: 'test',
      live: true,
      statusKind: 'running',
      needsInput: false,
    });
    expect(snapshot.target?.onDelete).toBeUndefined();
    expect(snapshot.target?.onExit).toEqual(expect.any(Function));
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    act(() => {
      snapshot.target?.onRename?.('Renamed');
    });
    expect(state.renameSession).toHaveBeenCalledWith('a1', 'Renamed');
  });

  it('still fires onPress', async () => {
    const onPress = vi.fn<() => void>();
    await act(async () => {
      const tree = createElement(
        QueryClientProvider,
        { client },
        createElement(RemoteSessionRow, { session, onPress })
      );
      renderer = TestRenderer.create(tree);
      await flush();
    });
    act(() => {
      pressableProps().onPress?.();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(getSessionPreviewSnapshot().target).toBeNull();
  });

  it('prefetches the transcript query options on press-in', async () => {
    await render();
    act(() => {
      pressableProps().onPressIn?.();
    });
    expect(prefetchSessionTranscript).toHaveBeenCalledWith(client, {
      queryKey: ['transcript', 'a1'],
    });
  });

  it('does not prefetch for a remote row without preview actions', async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RemoteSessionRow, { session, onPress: vi.fn(), interactive: false })
        )
      );
      await flush();
    });
    const props = pressableProps();
    expect(props.onLongPress).toBeUndefined();
    act(() => {
      props.onPressIn?.();
    });
    expect(prefetchSessionTranscript).not.toHaveBeenCalled();
  });

  it('opens the preview from the rotor manage action', async () => {
    await render();
    const props = pressableProps();
    expect(props.accessibilityActions).toEqual([{ name: 'manage', label: 'Session actions' }]);
    act(() => {
      props.onAccessibilityAction?.({ nativeEvent: { actionName: 'manage' } });
    });
    expect(getSessionPreviewSnapshot().target?.sessionId).toBe('a1');
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });
});
