// The to-do detail screen's states wear the stock pushed-screen header, named
// with the to-do surface's title until the read brings the to-do's own. The
// running read also reserves the eyebrow line the loaded body paints for the
// to-do's list, with its placeholder bar, so the body lands without moving. A
// read that stopped has no label coming: the terminal states drop that line, so
// the heading and its back control sit on the header's first line.

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
  title?: string;
  titleNumberOfLines?: number;
  reserveTitleSpace?: boolean;
  reserveEyebrow?: boolean;
  eyebrowPlaceholder?: unknown;
  backFallback?: unknown;
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

function renderScreen(itemId = 'item-1'): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(TodoDetailScreen, { itemId }));
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

describe('todo detail header', () => {
  it('reserves the list line under the surface title while the to-do loads', () => {
    query.isFetching = true;
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.title).toBe('To-dos');
    expect(headers.rendered[0]?.titleNumberOfLines).toBe(2);
    expect(headers.rendered[0]?.reserveTitleSpace).toBe(true);
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeTruthy();
    expect(headers.rendered[0]?.backFallback).toBe('/(app)/(tabs)/(2_agents)');
    renderer.unmount();
  });

  it('drops the list line on a not-found state', () => {
    query.isError = true;
    query.error = { data: { code: 'BAD_REQUEST' } };
    const renderer = renderScreen('not-a-seeded-item');

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.title).toBe('To-dos');
    expect(headers.rendered[0]?.reserveEyebrow).toBe(false);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeUndefined();
    expect(headers.rendered[0]?.backFallback).toBe('/(app)/(tabs)/(2_agents)');
    renderer.unmount();
  });

  it('keeps the plain header when the read fails on the server', () => {
    query.isError = true;
    query.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.title).toBe('To-dos');
    expect(headers.rendered[0]?.reserveEyebrow).toBe(false);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeUndefined();
    renderer.unmount();
  });
});

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

describe('todo detail error state', () => {
  it('reads an id the API refuses as not-found, centred and with no retry', () => {
    query.isError = true;
    query.error = { data: { code: 'BAD_REQUEST' } };
    const renderer = renderScreen('not-a-seeded-item');

    const error = renderer.root.findAllByType('QueryError')[0];
    expect(propOf(error, 'variant')).toBe('not-found');
    expect(propOf(error, 'onRetry')).toBeUndefined();
    // The state is the whole body under the header, so it takes the shared
    // centre placement instead of pinning to the top of the surface.
    expect(propOf(error, 'placement')).toBeUndefined();
    renderer.unmount();
  });

  it('keeps a read that failed on the server retryable on the same centred state', () => {
    query.isError = true;
    query.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = renderScreen();

    const error = renderer.root.findAllByType('QueryError')[0];
    expect(propOf(error, 'variant')).toBe('server');
    expect(typeof propOf(error, 'onRetry')).toBe('function');
    renderer.unmount();
  });
});
