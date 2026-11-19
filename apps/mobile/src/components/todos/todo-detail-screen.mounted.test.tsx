// The to-do detail screen's loading and error states wear the stock
// pushed-screen header, named with the to-do surface's title until the read
// brings the to-do's own. They reserve no eyebrow line for the list label the
// loaded body paints, so the heading and its back control sit on the header's
// first line like every other pushed screen's.

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
  it('names the states with the to-do surface on the stock header', () => {
    query.isFetching = true;
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.title).toBe('To-dos');
    expect(headers.rendered[0]?.titleNumberOfLines).toBe(2);
    expect(headers.rendered[0]?.reserveTitleSpace).toBe(true);
    // No eyebrow line: the heading and its back control stay on the header's
    // first line, where every other pushed screen puts them.
    expect(headers.rendered[0]?.reserveEyebrow).toBeUndefined();
    expect(headers.rendered[0]?.backFallback).toBe('/(app)/(tabs)/(2_agents)');
    renderer.unmount();
  });

  it('keeps that header when the read fails', () => {
    query.isError = true;
    query.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.title).toBe('To-dos');
    expect(headers.rendered[0]?.reserveEyebrow).toBeUndefined();
    expect(headers.rendered[0]?.backFallback).toBe('/(app)/(tabs)/(2_agents)');
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
