// The to-do detail screen's shell draws the loading and error states around one
// header. The loaded body paints the to-do's list on the eyebrow line, so that
// line stays reserved while the read runs and after it fails: the title holds
// the position the payload gives it instead of dropping up when an error lands
// and back down when a retry starts. Only the running read paints the
// placeholder bar; the failure keeps the line blank.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { TodoDetailScreen } from './todo-detail-screen';
import '@/i18n';

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
  isFetching: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

type HeaderProps = {
  eyebrow?: string;
  reserveEyebrow?: boolean;
  eyebrowPlaceholder?: unknown;
};

const headers = vi.hoisted(() => ({
  rendered: [] as HeaderProps[],
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('@/lib/haptics', () => ({ notificationHaptic: vi.fn() }));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/todos/todo-notes-section', () => ({ TodoNotesSection: 'TodoNotesSection' }));
vi.mock('@/components/todos/todo-session-row', () => ({ TodoSessionRow: 'TodoSessionRow' }));
vi.mock('@/components/todos/todo-start-actions', () => ({ TodoStartActions: 'TodoStartActions' }));
vi.mock('@/components/ui/icons', () => ({ Circle: 'Circle', CircleCheck: 'CircleCheck' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: HeaderProps) => {
    headers.rendered.push(props);
    return null;
  },
}));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useNowTicker: () => 0 }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#000', mutedForeground: '#888' }),
}));
vi.mock('@/lib/hooks/use-todos', () => ({
  useTodoItem: () => query,
  useTodoItemMutations: () => ({
    update: { mutate: vi.fn(), mutateAsync: vi.fn() },
    unlinkSession: { mutate: vi.fn() },
  }),
}));

function renderScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(TodoDetailScreen, { itemId: 'item-1' }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

beforeEach(() => {
  query.data = undefined;
  query.isError = false;
  query.isFetching = false;
  query.error = null;
  query.refetch.mockClear();
  headers.rendered = [];
});

describe('todo detail header eyebrow', () => {
  it('reserves the list line with the placeholder bar while the to-do loads', () => {
    query.isFetching = true;
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeTruthy();
    renderer.unmount();
  });

  it('keeps the reserved line blank when the read fails', () => {
    query.isError = true;
    query.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = renderScreen();

    // The title keeps the position the payload gives it, and no bar pulses on a
    // header whose label can only come back through a retry.
    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeUndefined();
    renderer.unmount();
  });
});
