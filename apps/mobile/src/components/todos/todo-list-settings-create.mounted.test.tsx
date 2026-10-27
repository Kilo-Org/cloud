import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type TodoList } from '@/lib/todos/todo-types';
import { act, TestRenderer } from '@/test/renderer';

import { TodoListSettingsSheet } from './todo-list-settings-sheet';

const created: TodoList = {
  id: 'list-new',
  organizationId: 'test-organization',
  name: 'Revisão do sprint de outubro com a equipe',
  emoji: '🗓',
  gitUrl: null,
  mode: null,
  model: null,
  variant: null,
  position: 'b',
  archivedAt: null,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  openCount: 0,
};

const state = vi.hoisted(() => ({
  create: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
}));

vi.mock('@/lib/hooks/use-todos', async () => {
  const React = await import('react');
  function useFakeMutation(kind: 'update' | 'create') {
    const [isPending, setPending] = React.useState(false);
    const run = kind === 'create' ? state.create : vi.fn();
    return {
      isPending,
      mutateAsync: async (call: unknown) => {
        setPending(true);
        try {
          const result: unknown = await run(call);
          return result;
        } finally {
          setPending(false);
        }
      },
      mutate: run,
    };
  }
  return {
    reportNothing: () => undefined,
    useTodoLists: () => ({ data: [], isSuccess: true }),
    useTodoListMutations: () => ({
      update: useFakeMutation('update'),
      create: useFakeMutation('create'),
    }),
  };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: state.replace, back: state.back, push: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => undefined,
}));
vi.mock('react-native', async () => {
  const boundary = await import('./todo-list-model-picker.mounted.test-helpers');
  return {
    BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    I18nManager: { isRTL: false },
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: boundary.NativeTextInput,
    View: 'View',
  };
});
vi.mock('@/components/sheet-header', async () => {
  const boundary = await import('./todo-list-model-picker.mounted.test-helpers');
  return { SheetHeader: boundary.NativeSheetHeader };
});
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false }),
}));
vi.mock('@/lib/use-new-session-repos', () => ({
  useNewSessionRepos: () => ({ repositories: [], recents: [], groups: [] }),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: [],
    favoritesError: null,
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111111',
    background: '#ffffff',
    mutedForeground: '#666666',
    primary: '#222222',
    warn: '#aa8800',
    destructive: '#cc0000',
  }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Bot: 'Bot',
  Brain: 'Brain',
  Bug: 'Bug',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  ImageIcon: 'ImageIcon',
  Info: 'Info',
  NotebookPen: 'NotebookPen',
  Search: 'Search',
  SearchX: 'SearchX',
  Star: 'Star',
  Workflow: 'Workflow',
  Wrench: 'Wrench',
  X: 'X',
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderedTree() {
  if (!renderer) {
    throw new Error('List settings have not mounted');
  }
  return renderer.root;
}

function host(root: TestRenderer.ReactTestInstance, type: string, props: Record<string, unknown>) {
  return root.find(node => {
    const actual = node.props as Record<string, unknown>;
    return (
      node.type === type && Object.entries(props).every(([key, value]) => actual[key] === value)
    );
  });
}

function enter(label: string, value: string) {
  const field = host(renderedTree(), 'TextInput', { accessibilityLabel: label });
  const props = field.props as { onChangeText: (text: string) => void; onFocus?: () => void };
  // Typing implies focus: the field only falls back to the start-visible
  // preview once it loses focus again.
  act(() => {
    props.onFocus?.();
  });
  act(() => {
    props.onChangeText(value);
  });
}

function saveButton() {
  return host(renderedTree(), 'Pressable', { accessibilityLabel: i18n.t('common.save') });
}

/** Press Done, then let the promise work it started settle inside act. */
async function pressDone() {
  const button = saveButton();
  const props = button.props as { onPress: () => void; disabled?: boolean };
  expect(props.disabled).not.toBe(true);
  await act(async () => {
    props.onPress();
    await Promise.resolve();
  });
}

function mount(afterCreate?: 'open' | 'back') {
  act(() => {
    renderer = TestRenderer.create(
      createElement(TodoListSettingsSheet, {
        listId: null,
        organizationId: 'test-organization',
        ...(afterCreate ? { afterCreate } : {}),
      })
    );
  });
}

beforeEach(async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  state.create.mockReset();
  state.create.mockResolvedValue(created);
  state.replace.mockReset();
  state.back.mockReset();
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('To-do list create outcome', () => {
  it('opens the created list instead of returning to the lists view', async () => {
    mount();

    enter(i18n.t('todos.listSettings.name'), created.name);
    enter(i18n.t('todos.listSettings.emoji'), created.emoji ?? '');
    await pressDone();

    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'test-organization',
      name: created.name,
      emoji: created.emoji,
      gitUrl: null,
      mode: null,
      model: null,
      variant: null,
    });
    expect(state.replace).toHaveBeenCalledExactlyOnceWith('/(app)/todos/list-new');
    expect(state.back).not.toHaveBeenCalled();
  });

  it('returns to the sheet that opened it when the caller asks for that', async () => {
    mount('back');

    enter(i18n.t('todos.listSettings.name'), created.name);
    await pressDone();

    expect(state.back).toHaveBeenCalledOnce();
    expect(state.replace).not.toHaveBeenCalled();
  });
});
