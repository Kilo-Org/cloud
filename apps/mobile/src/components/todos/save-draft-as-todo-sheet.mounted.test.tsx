/* eslint-disable max-lines -- the react-native and tRPC mock harness stays inline so the sheet's contract reads as one component */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake query factories settle without await because they resolve immediately */
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useEffect } from 'react';
import { toast } from 'sonner-native';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { handleTrpcQueryError, setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';

import { SaveDraftAsTodoSheet } from './save-draft-as-todo-sheet';
import { type TodoList } from '@/lib/todos/todo-types';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';
import { i18n } from '@/i18n';

const push = vi.hoisted(() => vi.fn());
// The router's `lists.list` returns a bare `TodoList[]`, so the fake query
// resolves the array the sheet filters.
const fetchLists = vi.hoisted(() => vi.fn<() => Promise<TodoList[]>>());
const createTodo = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());

const QUERY_KEY = ['todos-lists'];
const ORGANIZATION_ID = 'org-1';

type Mounted = RenderWithProvidersResult;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  // `useFocusEffect` runs on mount like the real hook does on a focused route,
  // so the mount-time restore is exercised.
  useFocusEffect: (effect: () => void) => {
    useEffect(effect, [effect]);
  },
  useRouter: () => ({ push }),
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// The real `QueryError` reaches `@sentry/react-native` through the centered-state
// geometry chain, and Sentry's entry loads real react-native, whose RN Promise
// polyfill the node-mounted harness cannot import (extension-less ESM import).
// The error branch is not under test here; the component stub cuts the chain.
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/icons', () => ({ ListTodo: 'ListTodo', X: 'X' }));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: (props: { visible: boolean; children: ReactNode }) =>
    createElement('Sheet', { visible: props.visible }, props.children),
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
  // The text-class context is a real context, not a host tag; the real module
  // is not loadable under the react-native mock above.
  TextClassContext: createContext(''),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primary: '#ff0',
    primaryForeground: '#000',
  }),
}));
vi.mock('@/lib/trpc', () => ({
  // The sheet used to call the client directly, outside the mutation cache.
  trpcClient: { todos: { items: { create: { mutate: createTodo } } } },
  useTRPC: () => ({
    todos: {
      pathFilter: () => ({ queryKey: ['todos'] }),
      items: {
        create: { mutationOptions: () => ({ mutationFn: createTodo }) },
      },
      lists: {
        list: {
          queryOptions: (_input: unknown) => ({
            queryKey: QUERY_KEY,
            queryFn: fetchLists,
            retryDelay: 0,
          }),
        },
      },
    },
  }),
}));

const LIST: TodoList = {
  id: 'list-1',
  organizationId: ORGANIZATION_ID,
  name: 'Errands',
  emoji: null,
  gitUrl: null,
  mode: null,
  model: null,
  variant: null,
  position: 'a',
  archivedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
  updatedAt: new Date(2026, 0, 1).toISOString(),
  openCount: 0,
};

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
function text(mounted: Mounted) {
  return mounted.renderer.root
    .findAll(node => (node.type as string) === 'Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join('\n');
}
function sheetVisible(mounted: Mounted): boolean {
  const sheet = mounted.renderer.root.find(node => (node.type as string) === 'Sheet');
  return Boolean(sheet.props.visible);
}
async function mountSheet(onSaved: () => void = () => undefined) {
  // The app's mutation cache hands every failure to the auth handler
  // (`createKiloAppQueryClient`); this client keeps only that wiring.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({
      onError: error => {
        void handleTrpcQueryError(error);
      },
    }),
  });
  const mounted = await renderWithProviders(
    createElement(SaveDraftAsTodoSheet, {
      visible: true,
      organizationId: ORGANIZATION_ID,
      getDraft: () => 'Fix the flake\nnotes',
      onSaved,
      onClose: () => undefined,
    }),
    { queryClient }
  );
  onTestFinished(mounted.unmount);
  return mounted;
}

async function tapList(mounted: Mounted): Promise<void> {
  await waitFor(() => controls(mounted).some(control => control.accessibilityLabel === 'Errands'));
  act(() => {
    controls(mounted)
      .find(control => control.accessibilityLabel === 'Errands')
      ?.onPress?.();
  });
}

const sessionEnded = Object.assign(new Error('User not authenticated'), {
  data: { code: 'UNAUTHORIZED', httpStatus: 401, authRequired: true },
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  push.mockReset();
  fetchLists.mockReset().mockResolvedValue([LIST]);
  createTodo.mockReset().mockResolvedValue({});
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe('SaveDraftAsTodoSheet', () => {
  it('renders the account lists as tappable rows', async () => {
    const mounted = await mountSheet();
    await waitFor(() =>
      controls(mounted).some(control => control.accessibilityLabel === 'Errands')
    );
    expect(text(mounted)).toContain('Errands');
    expect(
      controls(mounted).find(control => control.accessibilityLabel === 'Errands')
    ).toBeDefined();
    // The sheet's body scrolls, so the title row's close control is the exit
    // the native drag no longer provides.
    expect(
      controls(mounted).find(control => control.accessibilityLabel === i18n.t('common.close'))
    ).toBeDefined();
  });

  // The requested behaviour: the no-lists state keeps the empty message and
  // gains the create affordance instead of dead-ending.
  it('offers the create-list action when the account has no lists', async () => {
    fetchLists.mockResolvedValue([]);
    const mounted = await mountSheet();
    await waitFor(() => text(mounted).includes('No lists yet'));
    const create = controls(mounted).find(props => props.accessibilityLabel === 'New list');
    expect(create).toBeDefined();
    act(() => {
      create?.onPress?.();
    });
    expect(push).toHaveBeenCalledWith(
      '/(app)/todos/list-settings?organizationId=org-1&afterCreate=back'
    );
    // The create route is a formSheet and the native sheet stacks above a
    // formSheet route, so the sheet drops while the form is open.
    expect(sheetVisible(mounted)).toBe(false);
  });

  it('hands a refused session credential to the auth handler and keeps the draft', async () => {
    createTodo.mockRejectedValue(sessionEnded);
    // The handler ends the session, as `signOut` does: the auth epoch moves.
    const handler = vi.fn(() => {
      bumpAuthEpoch();
    });
    onTestFinished(setTrpcUnauthorizedHandler(handler));
    const onSaved = vi.fn<() => void>();
    const mounted = await mountSheet(onSaved);

    await tapList(mounted);

    await waitFor(() => handler.mock.calls.length > 0);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(handler).toHaveBeenCalledTimes(1);
    // The session-ended toast is the report; no raw server message over login.
    expect(toast.error).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('reports the failed save when the auth handler renewed the token', async () => {
    createTodo.mockRejectedValue(sessionEnded);
    const handler = vi.fn<() => void>();
    onTestFinished(setTrpcUnauthorizedHandler(handler));
    const onSaved = vi.fn<() => void>();
    const mounted = await mountSheet(onSaved);

    await tapList(mounted);

    await waitFor(() => vi.mocked(toast.error).mock.calls.length > 0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('User not authenticated');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows the failure and keeps the draft when the save fails', async () => {
    createTodo.mockRejectedValue(new Error('Server unavailable'));
    const onSaved = vi.fn<() => void>();
    const mounted = await mountSheet(onSaved);

    await tapList(mounted);

    await waitFor(() => vi.mocked(toast.error).mock.calls.length > 0);
    expect(toast.error).toHaveBeenCalledWith('Server unavailable');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('saves the draft into the list and lets the screen discard it', async () => {
    const onSaved = vi.fn<() => void>();
    const mounted = await mountSheet(onSaved);

    await tapList(mounted);

    await waitFor(() => onSaved.mock.calls.length > 0);
    expect(createTodo.mock.calls[0]?.[0]).toMatchObject({
      listId: 'list-1',
      title: 'Fix the flake',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
