// Android Back with the link-session sheet open belongs to the sheet, not to
// the to-do screen under it. The shared wrapper presents every sheet, so this
// suite mounts the real wrapper and the real sheet body: the press closes the
// sheet and reports itself handled, and a press taken while the sheet is closed
// is left to the navigator, so Back still leaves the to-do detail.
import { createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { TodoStartActions } from './todo-start-actions';
import { i18n } from '@/i18n';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';
import { type TodoItemDetail } from '@/lib/todos/todo-types';

const platform = vi.hoisted(() => ({ backListeners: [] as (() => boolean)[] }));

type SheetProps = { index?: number };

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      platform.backListeners.push(listener);
      return {
        remove: () => {
          const index = platform.backListeners.indexOf(listener);
          if (index !== -1) {
            platform.backListeners.splice(index, 1);
          }
        },
      };
    },
  },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The native presentation is the one part a node test cannot run; everything
// above it — the wrapper's handler, the sheet body, the host's own state —
// stays the real implementation.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheet: (props: { children?: ReactNode }) =>
    createElement('BottomSheet', props, props.children),
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: ReactNode; accessibilityLabel?: string; onPress?: () => void }) =>
    createElement('Button', props, props.children),
}));
vi.mock('@/components/ui/icons', () => ({ Link2: 'Link2', Play: 'Play', X: 'X' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalArrowRight: 'Arrow' }));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  TextClassContext: { Provider: (props: { children?: ReactNode }) => props.children },
}));
// The sheet's load-failure body reaches the centred-state motion surface, whose
// native reader the node project cannot load; this suite is about Back, not
// that body.
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/todos/use-start-todo', () => ({
  useStartTodo: () => ({ review: vi.fn(), startNow: vi.fn(), isStarting: () => false }),
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/components/agents/session-detail-rename-state', () => ({
  namedSessionTitle: (title: string | null) => title,
}));
vi.mock('@kilocode/app-shared/git-url-project', () => ({
  formatGitUrlProject: (gitUrl: string) => gitUrl,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));
vi.mock('@/lib/hooks/use-todos', () => ({
  useTodoItemMutations: () => ({ linkSession: { mutate: vi.fn() } }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      list: {
        infiniteQueryOptions: () => ({
          queryKey: ['stored-sessions'],
          queryFn: () => Promise.resolve({ cliSessions: [] }),
          initialPageParam: null,
          getNextPageParam: () => undefined,
          retryDelay: 0,
        }),
      },
    },
  }),
}));

const TODO: TodoItemDetail = {
  id: 'item-1',
  listId: 'list-1',
  title: 'Ship the release',
  notes: '',
  doneAt: null,
  position: 'a0',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessions: [],
  list: {
    id: 'list-1',
    organizationId: null,
    name: 'Release',
    emoji: null,
    gitUrl: null,
    mode: null,
    model: null,
    variant: null,
    position: 'a0',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    openCount: 1,
  },
};

type Mounted = RenderWithProvidersResult;

type ButtonProps = { children?: ReactNode; onPress?: () => void };

function textOf(children: unknown): string {
  if (typeof children === 'string') {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(child => textOf(child)).join('');
  }
  if (children !== null && typeof children === 'object' && 'props' in children) {
    const { props } = children;
    if (props !== null && typeof props === 'object' && 'children' in props) {
      return textOf(props.children);
    }
  }
  return '';
}

/** The host's Link session control, found by the copy it renders. */
function linkControl(mounted: Mounted) {
  return mounted.renderer.root
    .findAll(node => (node.type as string) === 'Button')
    .map(node => node.props as ButtonProps)
    .find(props => textOf(props.children) === i18n.t('todos.item.linkSession'));
}

/** The wrapper's committed presentation: `0` while the sheet is up, `-1` while it is down. */
function presentationIndex(mounted: Mounted): number {
  const presentation = mounted.renderer.root
    .findAll(node => (node.type as string) === 'BottomSheet')
    .at(0);
  if (presentation === undefined) {
    // Down: the wrapper unmounts its presentation once the dismissal reports.
    return -1;
  }
  // The node is this suite's own stub, whose props the wrapper passes through.
  const props = presentation.props as SheetProps;
  return props.index ?? -1;
}

async function pressBack(): Promise<boolean> {
  const listener = platform.backListeners.at(-1);
  if (!listener) {
    throw new Error('no app-level back listener registered');
  }
  let handled = false;
  await act(async () => {
    handled = listener();
    await Promise.resolve();
  });
  return handled;
}

async function mountHost() {
  const mounted = await renderWithProviders(
    createElement(TodoStartActions, { todo: TODO, organizationId: 'org-1' })
  );
  onTestFinished(mounted.unmount);
  return mounted;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  platform.backListeners.length = 0;
});

describe('TodoStartActions Back with the link-session sheet', () => {
  it('closes the sheet and keeps the press off the navigator', async () => {
    const mounted = await mountHost();
    expect(presentationIndex(mounted)).toBe(-1);

    const link = linkControl(mounted);
    expect(link).toBeDefined();
    await act(async () => {
      link?.onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => presentationIndex(mounted) === 0);

    expect(await pressBack()).toBe(true);
    await waitFor(() => presentationIndex(mounted) === -1);
  });

  it('leaves Back to the navigator while the sheet is closed', async () => {
    const mounted = await mountHost();

    expect(await pressBack()).toBe(false);
    expect(presentationIndex(mounted)).toBe(-1);
  });
});
