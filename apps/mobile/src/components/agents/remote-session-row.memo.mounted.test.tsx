import { createElement, type ReactElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { RemoteSessionRow } from './remote-session-row';
import { makeCached } from '@/lib/active-sessions-live-sync.test-helpers';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { createKiloAppQueryClient } from '@/lib/query-client';

// The row renders one child `SessionRow`; counting its renders counts the row's
// own commits (an un-memoised row re-renders it, a memoised one bails out).
const sessionRowRenders = vi.hoisted(() => ({ count: 0 }));
// `formatSpokenCost` is called once per derivation of the memoised row data, so
// its call count is the observable for "the row did not redo its derivations".
const spokenCostCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/components/ui/session-row', async () => {
  const { createElement: create } = await import('react');
  return {
    SessionRow: (props: Record<string, unknown>) => {
      sessionRowRenders.count += 1;
      return create('SessionRow', props);
    },
  };
});
vi.mock('./session-row-accessibility-label', async importOriginal => {
  const actual = (await importOriginal()) as {
    formatSpokenCost: (microdollars: number | null | undefined) => string | null;
  };
  return {
    ...actual,
    formatSpokenCost: (microdollars: number | null | undefined) => {
      spokenCostCalls.count += 1;
      return actual.formatSpokenCost(microdollars);
    },
  };
});
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', Platform: { OS: 'ios' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedSoft: '#777777' }),
}));
vi.mock('@/lib/hooks/use-session-mutations', () => ({
  useSessionMutations: () => ({ renameSession: vi.fn() }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
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
  useUserWebConnection: () => ({ sendCommand: vi.fn() }),
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
  showRemoteSessionExitConfirmation: vi.fn().mockResolvedValue(true),
}));
// The exit helper pulls `sonner-native` (and its native toast adapter), which
// the node mounted project cannot load. This suite never exits a session.
vi.mock('./exit-remote-session-from-list', () => ({
  exitRemoteSessionFromList: vi.fn(),
}));
vi.mock('@/lib/session-attention', () => ({
  isAttentionAcked: () => false,
  reconcileSessionAttention: vi.fn(),
  shouldShowNeedsInput: () => false,
  useSessionAttentionRevision: () => 0,
}));

type RowProps = {
  session: ActiveSession;
  onPress: (session: ActiveSession) => void;
  interactive?: boolean;
};

/** The list parent: not memoised, so an `update` re-renders it with new props. */
function Parent({ session, onPress, interactive = true }: RowProps) {
  return createElement(RemoteSessionRow, { session, onPress, interactive });
}

function mountTree(ui: ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(ui);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

describe('RemoteSessionRow memoisation', () => {
  let client: QueryClient = createKiloAppQueryClient();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sessionRowRenders.count = 0;
    spokenCostCalls.count = 0;
    client = createKiloAppQueryClient();
    client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  });

  it('skips the row body for identical props and re-renders it for a new session', () => {
    const session = makeCached({
      id: 'memo-1',
      status: 'busy',
      title: 'Memo work',
      createdOnPlatform: 'cli',
      gitBranch: 'feature/memo',
      updatedAt: '2026-08-28T11:55:00.000Z',
    });
    const onPress = vi.fn<(session: ActiveSession) => void>();
    const tree = (next: ActiveSession, interactive = true) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(Parent, { session: next, onPress, interactive })
      );
    const renderer = mountTree(tree(session));
    expect(sessionRowRenders.count).toBe(1);
    expect(spokenCostCalls.count).toBe(1);

    // The shape an unchanged-payload poll writes: the same session object and
    // the same stable handler. The memoised row must not re-render at all.
    act(() => {
      renderer.update(tree(session));
    });
    expect(sessionRowRenders.count).toBe(1);
    expect(spokenCostCalls.count).toBe(1);

    // A parent commit that does re-run the row body without touching the
    // session (here the `interactive` prop) reuses the memoised derivations.
    act(() => {
      renderer.update(tree(session, false));
    });
    expect(sessionRowRenders.count).toBe(2);
    expect(spokenCostCalls.count).toBe(1);

    // A new session object re-derives and re-renders.
    act(() => {
      renderer.update(tree({ ...session }));
    });
    expect(sessionRowRenders.count).toBe(3);
    expect(spokenCostCalls.count).toBe(2);

    act(() => {
      renderer.unmount();
    });
  });
});
