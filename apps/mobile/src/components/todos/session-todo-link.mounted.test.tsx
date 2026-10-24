// The session menu's to-do row opens the linked to-do on press, so the row must
// name the picker as an accessibility action (and keep it on long press) and
// describe the press it actually performs.

import { createContext, createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { SessionTodoLinkRow } from './session-todo-link';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';
import '@/i18n';

type LinkedTodo = { id: string; title: string };

const state = vi.hoisted(() => ({
  todo: null as LinkedTodo | null,
  sessionId: 'ses_todo_link_01',
}));
const push = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());

type Mounted = RenderWithProvidersResult;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  I18nManager: { isRTL: false },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// The direction wrapper is real; the raw icons it picks between are stubs.
vi.mock('@/components/ui/icons', () => ({
  ListTodo: 'ListTodo',
  ChevronRight: 'ChevronRight',
  ChevronLeft: 'ChevronLeft',
  ArrowRight: 'ArrowRight',
  ArrowLeft: 'ArrowLeft',
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: (props: { visible: boolean; children: ReactNode }) =>
    createElement('Sheet', { visible: props.visible }, props.children),
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  TextClassContext: createContext(''),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666', primaryForeground: '#000' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    todos: {
      items: {
        linkSession: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      },
    },
  }),
}));
vi.mock('@/lib/hooks/use-todos', () => ({
  useSessionTodo: () => ({ data: state.todo }),
  useTodoCandidates: () => ({
    data: [],
    isPending: false,
    isError: false,
    isFetching: false,
    refetch,
  }),
  invalidateTodoQueries: vi.fn(),
}));

type RowProps = {
  accessibilityHint?: string;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  onPress?: () => void;
  onLongPress?: () => void;
};

function row(mounted: Mounted): RowProps {
  const rows = mounted.renderer.root.findAll(node => (node.type as string) === 'Pressable');
  const first = rows[0];
  if (!first) {
    throw new Error('the to-do row did not render');
  }
  return first.props as RowProps;
}

function texts(mounted: Mounted): string {
  return mounted.renderer.root
    .findAll(node => (node.type as string) === 'Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join('\n');
}

function pickerVisible(mounted: Mounted): boolean {
  const sheet = mounted.renderer.root.find(node => (node.type as string) === 'Sheet');
  return Boolean(sheet.props.visible);
}

async function mountRow(): Promise<Mounted> {
  const mounted = await renderWithProviders(
    createElement(SessionTodoLinkRow, { sessionId: state.sessionId })
  );
  onTestFinished(mounted.unmount);
  await waitFor(
    () => mounted.renderer.root.findAll(node => (node.type as string) === 'Sheet').length > 0
  );
  return mounted;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.todo = null;
  push.mockReset();
  refetch.mockReset();
});

describe('SessionTodoLinkRow', () => {
  it('names the picker as an accessibility action on a linked row and opens it', async () => {
    state.todo = { id: 'item-1', title: 'Fix the flake' };
    const mounted = await mountRow();
    const props = row(mounted);
    expect(props.accessibilityActions).toEqual([
      { name: 'changeTodo', label: 'Move to another to-do' },
    ]);
    expect(pickerVisible(mounted)).toBe(false);
    act(() => {
      props.onAccessibilityAction?.({ nativeEvent: { actionName: 'changeTodo' } });
    });
    expect(pickerVisible(mounted)).toBe(true);
  });

  it('describes the linked row press as opening the to-do', async () => {
    state.todo = { id: 'item-1', title: 'Fix the flake' };
    const mounted = await mountRow();
    expect(texts(mounted)).toContain('To-do: Fix the flake');
    expect(row(mounted).accessibilityHint).toBe('Opens the to-do.');
  });

  it('keeps the picker on the long press as well', async () => {
    state.todo = { id: 'item-1', title: 'Fix the flake' };
    const mounted = await mountRow();
    act(() => {
      row(mounted).onLongPress?.();
    });
    expect(pickerVisible(mounted)).toBe(true);
  });

  it('opens the picker straight from the press when nothing is linked', async () => {
    const mounted = await mountRow();
    expect(texts(mounted)).toContain('Link to to-do');
    const props = row(mounted);
    expect(props.accessibilityActions).toBeUndefined();
    expect(props.accessibilityHint).toBeUndefined();
    act(() => {
      props.onPress?.();
    });
    expect(pickerVisible(mounted)).toBe(true);
  });
});
