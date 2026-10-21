import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelPickerContent } from '@/components/agents/model-picker-content';
import { i18n } from '@/i18n';
import type * as AvailableModels from '@/lib/hooks/use-available-models';
import { modelPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { type TodoList } from '@/lib/todos/todo-types';
import { act, TestRenderer } from '@/test/renderer';

import { PickerRouteStack } from './todo-list-model-picker.mounted.test-helpers';
import { TodoListSettingsSheet } from './todo-list-settings-sheet';

const state = vi.hoisted(() => ({
  list: undefined as TodoList | undefined,
  update: vi.fn(),
  create: vi.fn(),
  favorites: [] as string[],
  models: [
    { id: 'test/initial', name: 'Initial Model', variants: ['low', 'medium'], isPreferred: false },
    { id: 'test/chosen', name: 'Chosen Model', variants: ['high', 'max'], isPreferred: false },
  ] as AvailableModels.ModelOption[],
}));

// vi.mock factories are hoisted above this file's static imports, so the boundary
// helper cannot be a static import here.
vi.mock('expo-router', async () => {
  const boundary = await import('./todo-list-model-picker.mounted.test-helpers');
  return {
    useRouter: boundary.useTestRouter,
    useLocalSearchParams: boundary.useTestLocalSearchParams,
    useFocusEffect: boundary.useTestFocusEffect,
  };
});
vi.mock('react-native', async () => {
  const { NativeTextInput } = await import('./todo-list-model-picker.mounted.test-helpers');
  return {
    I18nManager: { isRTL: false },
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: NativeTextInput,
    View: 'View',
  };
});
vi.mock('@shopify/flash-list', async () => {
  const { NativeFlashList } = await import('./todo-list-model-picker.mounted.test-helpers');
  return { FlashList: NativeFlashList };
});
vi.mock('@/components/sheet-header', async () => {
  const { NativeSheetHeader } = await import('./todo-list-model-picker.mounted.test-helpers');
  return { SheetHeader: NativeSheetHeader };
});
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('@/lib/hooks/use-available-models', async importOriginal => {
  const actual = await importOriginal<typeof AvailableModels>();
  return {
    ...actual,
    useAvailableModels: () => ({ models: state.models, isLoading: false }),
  };
});
vi.mock('@/lib/hooks/use-todos', () => ({
  useTodoLists: () => ({ data: state.list ? [state.list] : [], isSuccess: true }),
  useTodoListMutations: () => ({
    update: { mutate: state.update, isPending: false },
    create: { mutate: state.create, isPending: false },
  }),
}));
vi.mock('@/lib/use-new-session-repos', () => ({
  useNewSessionRepos: () => ({
    repositories: [{ platform: 'github', fullName: 'test/project', isPrivate: false }],
    recents: [],
    groups: [],
  }),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: state.favorites,
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
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title, action }: { title: string; action?: ReactNode }) =>
    createElement('EmptyState', { title }, action),
}));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  BookOpenCheck: 'BookOpenCheck',
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

function isTextNode(child: TestRenderer.ReactTestInstance | string): child is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- test-renderer children are a string-or-instance union
  return typeof child === 'string';
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => (isTextNode(child) ? child : textContent(child))).join(' ');
}

function pressableWithText(label: string) {
  return renderedTree().find(
    node => (node.type as string) === 'Pressable' && textContent(node) === label
  );
}

function button(root: TestRenderer.ReactTestInstance, label: string) {
  return host(root, 'Pressable', { accessibilityLabel: label });
}

function press(node: TestRenderer.ReactTestInstance) {
  const props = node.props as { onPress: () => void; disabled?: boolean };
  expect(props.disabled).not.toBe(true);
  act(() => {
    props.onPress();
  });
}

function input(label: string) {
  return host(renderedTree(), 'TextInput', { accessibilityLabel: label });
}

function enter(label: string, value: string) {
  const props = input(label).props as { onChangeText: (text: string) => void };
  act(() => {
    props.onChangeText(value);
  });
}

function thinkingEffortChipLabel(model: string, effort: string) {
  return i18n.t('agentChat.modelSelector.thinkingEffortWithModel', {
    model,
    variant: i18n.t(`models.thinkingEffort.${effort}`),
  });
}

beforeEach(async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  state.update.mockReset();
  state.create.mockReset();
  modelPickerSlot.clearAll();
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  modelPickerSlot.clearAll();
});

describe('To-do list settings model picker return', () => {
  it.each([
    ['personal', null],
    ['organization', 'test-organization'],
  ] as const)(
    'Done keeps the edited %s list settings open and saves the selected defaults',
    (_scope, organizationId) => {
      const list: TodoList = {
        id: 'test-list',
        organizationId,
        name: 'Saved name',
        emoji: null,
        gitUrl: 'test/project',
        mode: 'plan',
        model: 'test/initial',
        variant: 'low',
        position: 'a',
        archivedAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        openCount: 1,
      };
      state.list = list;
      act(() => {
        renderer = TestRenderer.create(
          createElement(PickerRouteStack, {
            settings: createElement(TodoListSettingsSheet, {
              listId: list.id,
              organizationId,
            }),
            picker: createElement(ModelPickerContent),
          })
        );
      });

      const nameLabel = i18n.t('todos.listSettings.name');
      const emojiLabel = i18n.t('todos.listSettings.emoji');
      enter(nameLabel, 'Unsaved edited name');
      enter(emojiLabel, 'X');
      press(pressableWithText(i18n.t('todos.lists.noRepository')));
      press(button(renderedTree(), thinkingEffortChipLabel('Initial Model', 'low')));
      expect(modelPickerSlot.get(UNFENCED_ROUTE_KEY)).toMatchObject({
        currentValue: 'test/initial',
        currentVariant: 'low',
      });

      const picker = host(renderedTree(), 'TestRoute', { focused: true });
      const chosenRow = picker.find(node => {
        const props = node.props as { accessibilityLabel?: string };
        return (
          (node.type as string) === 'Pressable' &&
          props.accessibilityLabel?.includes('test/chosen') === true
        );
      });
      press(chosenRow);

      expect(
        host(picker, 'SheetHeader', { title: i18n.t('agentChat.modelPicker.title') })
      ).toBeDefined();
      expect(textContent(picker)).toContain(i18n.t('models.thinkingEffort.high'));
      expect(state.update).not.toHaveBeenCalled();

      press(button(picker, i18n.t('common.done')));

      expect(renderedTree().findAllByType('TestRoute')).toHaveLength(1);
      expect(renderedTree().findAllByType('FlashList')).toHaveLength(0);
      const settings = renderedTree().findByType('TestRoute');
      expect(settings.props).toMatchObject({ focused: true });
      expect(
        host(settings, 'SheetHeader', { title: i18n.t('todos.listSettings.title') })
      ).toBeDefined();

      const chip = button(settings, thinkingEffortChipLabel('Chosen Model', 'high'));
      expect(textContent(chip)).toContain('Chosen Model');
      expect(textContent(chip)).toContain(i18n.t('models.thinkingEffort.high'));
      expect(input(nameLabel).props).toMatchObject({ value: 'Unsaved edited name' });
      expect(input(emojiLabel).props).toMatchObject({ value: 'X' });
      expect(modelPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();

      press(button(settings, i18n.t('common.save')));

      expect(state.update).toHaveBeenCalledExactlyOnceWith({
        id: 'test-list',
        name: 'Unsaved edited name',
        emoji: 'X',
        gitUrl: null,
        mode: 'plan',
        model: 'test/chosen',
        variant: 'high',
      });
      expect(state.create).not.toHaveBeenCalled();
      expect(renderedTree().findAllByType('TestRoute')).toHaveLength(0);
    }
  );
});
