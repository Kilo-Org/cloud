/* eslint-disable typescript-eslint/no-deprecated -- DOM-free React Native row integration */
import { createElement } from 'react';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteSessionRow } from './remote-session-row';
import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  deferred,
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
  exit: undefined as (() => void) | undefined,
  request: vi.fn<() => Promise<CachedActiveSessionsData>>(),
  send: vi.fn(),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: state.organizationId, isLoaded: true }),
}));
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ sendCommand: state.send }),
}));
vi.mock('@/lib/hooks/use-session-mutations', () => ({
  useSessionMutations: () => ({ renameSession: vi.fn() }),
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
vi.mock('@/components/agents/session-row-actions', () => ({
  showSessionActionMenu: (options: { onExit?: () => void }) => {
    state.exit = options.onExit;
  },
  copySessionId: vi.fn(),
  showRenamePrompt: vi.fn(),
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

async function flush() {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
async function render() {
  await act(async () => {
    const tree = createElement(
      QueryClientProvider,
      { client },
      createElement(RemoteSessionRow, { session, onPress: vi.fn<() => void>() })
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
async function exit() {
  await act(async () => {
    if (!renderer) {
      throw new Error('Missing row');
    }
    const props = renderer.root.findByType('Pressable').props as { onLongPress: () => void };
    props.onLongPress();
    if (!state.exit) {
      throw new Error('Missing exit action');
    }
    state.exit();
    await flush();
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setSignOutActive(false);
  state.organizationId = null;
  state.exit = undefined;
  state.request.mockReset().mockResolvedValue({ sessions: [] });
  state.send.mockReset().mockResolvedValue(undefined);
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
