// Tap geometry of the to-do list's "Completed" disclosure: the size audit reads
// the frame the row renders, and NativeWind's 14pt rem makes a `py-3` row with
// its one eyebrow line 43dp tall. The row carries the shared 48dp row floor.

import { createElement } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import '@/i18n';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { act, TestRenderer } from '@/test/renderer';

import { TodoListScreen } from './todo-list-screen';

const LIST = { id: 'list-1', name: 'Release', emoji: null };
const DONE_ITEM = { id: 'todo-1', listId: 'list-1', title: 'Shipped', doneAt: '2026-01-01' };

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-haptics', () => ({ NotificationFeedbackType: { Success: 'success' } }));
vi.mock('@/lib/haptics', () => ({ notificationHaptic: vi.fn(), selectionHaptic: vi.fn() }));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('react-native-reanimated', () => ({
  default: { ScrollView: 'ScrollView' },
  useAnimatedRef: () => ({ current: null }),
}));
vi.mock('react-native-sortables', () => ({ default: { Grid: 'SortableGrid' } }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/todos/todo-item-row', () => ({ TodoItemRow: 'TodoItemRow' }));
vi.mock('@/components/todos/todo-quick-add', () => ({ TodoQuickAdd: 'TodoQuickAdd' }));
vi.mock('@/components/todos/use-start-todo', () => ({
  useStartTodo: () => ({ review: vi.fn(), startNow: vi.fn(), isStarting: () => false }),
}));
vi.mock('@/components/todos/use-todo-list-defaults-summary', () => ({
  useTodoListDefaultsSummary: () => null,
}));
vi.mock('@/components/ui/row-chevron', () => ({ RowChevron: 'RowChevron' }));
vi.mock('@/components/ui/row-frame', () => ({ RowFrame: 'RowFrame' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown', Settings2: 'Settings2' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-todos', () => ({
  PENDING_TODO_ID_PREFIX: 'pending-',
  useTodoLists: () => ({ data: [LIST], isPending: false, isSuccess: true }),
  useTodoItems: () => ({ data: [DONE_ITEM], isPending: false, isError: false }),
  useTodoItemMutations: () => ({
    create: { mutateAsync: vi.fn() },
    update: { mutate: vi.fn() },
    move: { mutate: vi.fn() },
    removeWithUndo: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));

describe('TodoListScreen', () => {
  it('gives the Completed disclosure the shared row floor', () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(createElement(TodoListScreen, { listId: LIST.id }));
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('list screen did not mount');
    }
    onTestFinished(renderer.unmount);

    // Row and header controls are mocked, so the disclosure is the one host
    // Pressable that reports an expanded state. The renderer types host types as
    // intrinsic tag names, so the type check goes through `String`.
    const toggle = renderer.root.find(
      node => String(node.type) === 'Pressable' && 'accessibilityState' in node.props
    );
    expect(String(toggle.props.className).split(' ')).toContain(ROW_TARGET_CLASS);
  });
});
