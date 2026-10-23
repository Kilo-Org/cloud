// The link-session sheet is a half-detent sheet whose body is a scroll view, so
// the native sheet cannot dismiss it on a gesture: the title row's close control
// is the one exit a sighted or screen-reader user can rely on, in every state
// (loading, error, empty, list). Android Back and the scrim stay armed through
// `enablePanDownToClose`, which the sheet wrapper hardcodes.
import { createContext, createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { TodoLinkSessionSheet } from './todo-link-session-sheet';
import { i18n } from '@/i18n';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

type StoredSessionRow = {
  session_id: string;
  title: string | null;
  git_url: string | null;
};

const fetchSessions = vi.hoisted(() => vi.fn<() => Promise<{ cliSessions: StoredSessionRow[] }>>());
const onClose = vi.hoisted(() => vi.fn<() => void>());
const onLink = vi.hoisted(() => vi.fn<(sessionId: string) => void>());

type Mounted = RenderWithProvidersResult;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({ X: 'X' }));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  // The text-class context is a real context, not a host tag; the real module is
  // not loadable under the react-native mock above.
  TextClassContext: createContext(''),
}));
vi.mock('@/components/ui/sheet', () => ({
  // Pass every prop through so the suite can read the gesture contract the
  // wrapper's consumer sets.
  Sheet: (props: { children: ReactNode }) => createElement('Sheet', props, props.children),
}));
// The row copy helpers reach native-backed storage and the intl cache; the
// close control does not depend on either, so they stay trivial here.
vi.mock('@/components/agents/session-detail-rename-state', () => ({
  namedSessionTitle: (title: string | null) => title,
}));
vi.mock('@/components/agents/session-list-helpers', () => ({
  formatGitUrlProject: (gitUrl: string) => gitUrl,
  projectOptionKey: (value: string) => value.toLowerCase(),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({}) }));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  buildStoredSessionsQueryOptions: () => ({
    queryKey: ['stored-sessions'],
    queryFn: fetchSessions,
    // TanStack v5 refuses an infinite query without an initial page param; the
    // real builder gets one from `infiniteQueryOptions`.
    initialPageParam: null,
    getNextPageParam: () => undefined,
    retryDelay: 0,
  }),
}));

type ControlProps = {
  accessibilityRole?: string;
  accessibilityLabel?: string;
  onPress?: () => void;
};

function controls(mounted: Mounted) {
  return (
    mounted.renderer.root
      // The renderer types `node.type` as RN's host-tag union, which does not
      // include the test's string stubs, so the tag reads as the unknown it is.
      .findAll(node => (node.type as string) === 'Pressable')
      .map(node => node.props as ControlProps)
  );
}

function closeControl(mounted: Mounted): ControlProps | undefined {
  return controls(mounted).find(control => control.accessibilityLabel === i18n.t('common.close'));
}

function sheetProps(mounted: Mounted) {
  return mounted.renderer.root.find(node => (node.type as string) === 'Sheet').props as {
    dismissGestures?: boolean;
  };
}

function bodyText(mounted: Mounted): string {
  return mounted.renderer.root
    .findAll(node => (node.type as string) === 'Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join('\n');
}

async function mountSheet(gitUrl: string | null = null) {
  const mounted = await renderWithProviders(
    createElement(TodoLinkSessionSheet, {
      visible: true,
      todo: { id: 'todo-1', sessions: [] },
      list: { organizationId: 'org-1', gitUrl },
      onLink,
      onClose,
    })
  );
  onTestFinished(mounted.unmount);
  return mounted;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onClose.mockReset();
  onLink.mockReset();
  fetchSessions.mockReset();
});

describe('TodoLinkSessionSheet', () => {
  it('closes from the empty state, where no session row offers an exit', async () => {
    fetchSessions.mockResolvedValue({ cliSessions: [] });
    const mounted = await mountSheet();
    await waitFor(() => bodyText(mounted).includes(i18n.t('todos.linkSession.empty')));

    const close = closeControl(mounted);
    expect(close).toBeDefined();
    act(() => {
      close?.onPress?.();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes from the candidate list and still links a picked session', async () => {
    fetchSessions.mockResolvedValue({
      cliSessions: [
        { session_id: 'session-1', title: 'Refactor the parser', git_url: null },
        { session_id: 'session-2', title: 'Fix the flake', git_url: null },
      ],
    });
    const mounted = await mountSheet();
    await waitFor(() => bodyText(mounted).includes('Fix the flake'));

    const close = closeControl(mounted);
    expect(close).toBeDefined();
    act(() => {
      close?.onPress?.();
    });
    expect(onClose).toHaveBeenCalledOnce();

    // The close control is one control among the rows, not a replacement for
    // them: picking a session still reports the choice and never closes first.
    const row = controls(mounted).find(control => control.accessibilityLabel === 'Fix the flake');
    act(() => {
      row?.onPress?.();
    });
    expect(onLink).toHaveBeenCalledWith('session-2');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the close control while the sessions are still loading', async () => {
    fetchSessions.mockReturnValue(new Promise(() => undefined));
    const mounted = await mountSheet();
    await waitFor(() => bodyText(mounted).includes(i18n.t('todos.linkSession.title')));

    const close = closeControl(mounted);
    expect(close).toBeDefined();
    act(() => {
      close?.onPress?.();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('turns off the native drag dismissal, because the body scrolls', async () => {
    fetchSessions.mockResolvedValue({ cliSessions: [] });
    const mounted = await mountSheet('kilo-org/cloud');
    await waitFor(() => closeControl(mounted) !== undefined);

    // An enabled drag is claimed by the native sheet over the scroll view, so
    // dragging the list back up would dismiss the sheet mid-pick.
    expect(sheetProps(mounted).dismissGestures).toBe(false);
  });
});
