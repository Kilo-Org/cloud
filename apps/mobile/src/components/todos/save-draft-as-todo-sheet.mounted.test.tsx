/* eslint-disable max-lines -- the react-native and tRPC mock harness stays inline so the sheet's contract reads as one component */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake query factories settle without await because they resolve immediately */
import { createContext, createElement, type ReactNode, useEffect } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { SaveDraftAsTodoSheet } from './save-draft-as-todo-sheet';
import { type TodoList } from '@/lib/todos/todo-types';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';
import '@/i18n';

const push = vi.hoisted(() => vi.fn());
// The router's `lists.list` returns a bare `TodoList[]`, so the fake query
// resolves the array the sheet filters.
const fetchLists = vi.hoisted(() => vi.fn<() => Promise<TodoList[]>>());

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
vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn() }));
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
vi.mock('@/components/ui/icons', () => ({ ListTodo: 'ListTodo' }));
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
  trpcClient: {
    todos: {
      items: {
        create: { mutate: vi.fn(async () => ({})) },
      },
    },
  },
  useTRPC: () => ({
    todos: {
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
async function mountSheet() {
  const mounted = await renderWithProviders(
    createElement(SaveDraftAsTodoSheet, {
      visible: true,
      organizationId: ORGANIZATION_ID,
      getDraft: () => 'Fix the flake\nnotes',
      onSaved: () => undefined,
      onClose: () => undefined,
    })
  );
  onTestFinished(mounted.unmount);
  return mounted;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  push.mockReset();
  fetchLists.mockReset().mockResolvedValue([LIST]);
});

describe('SaveDraftAsTodoSheet', () => {
  it('renders the account lists as tappable rows', async () => {
    const mounted = await mountSheet();
    await waitFor(() => controls(mounted).length === 1);
    expect(text(mounted)).toContain('Errands');
    expect(controls(mounted)[0]?.accessibilityLabel).toBe('Errands');
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
});
