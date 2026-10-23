import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type TodoItemDetail } from '@/lib/todos/todo-types';
import { act, TestRenderer } from '@/test/renderer';

import { TodoNotesSection } from './todo-notes-section';

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() }));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ EYEBROW_LATIN_DISPLAY: '', Text: 'Text' }));
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/hooks/use-todos', () => ({
  useTodoItemMutations: () => ({ update: mutation }),
}));

const NOTES = '# 背景\n\n読み上げでメモの本文が読めるかを確認する。\n\n- 手順を確認する';

function todoWithNotes(notes: string): TodoItemDetail {
  return {
    id: 'item-1',
    listId: 'list-1',
    title: 'Ship the release',
    notes,
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
  } satisfies TodoItemDetail;
}

/** Host elements are the mocked primitives, so a type check has to go through `string`. */
function isHost(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

/** The Pressable whose subtree carries this text, e.g. the empty-state prompt. */
function pressableAround(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance {
  const text = root.find(
    node => isHost(node, 'Text') && (node.children as unknown[]).includes(label)
  );
  const pressable = text.parent;
  if (!pressable || !isHost(pressable, 'Pressable')) {
    throw new Error(`no pressable around "${label}"`);
  }
  return pressable;
}

function renderNotes(notes: string): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(TodoNotesSection, { todo: todoWithNotes(notes) })
    );
  });
  if (!ref.current) {
    throw new Error('notes section did not mount');
  }
  return ref.current;
}

describe('TodoNotesSection', () => {
  it('renders saved notes as markdown instead of one button', () => {
    const renderer = renderNotes(NOTES);

    const markdown = renderer.root.find(node => isHost(node, 'MarkdownText'));
    expect(markdown.props.value).toBe(NOTES);
    // Nothing between the section and the rendered notes may turn the whole
    // body into one element: a Pressable ancestor would merge every heading and
    // paragraph into a single button, which is what hid the note from a screen
    // reader.
    for (let node = markdown.parent; node; node = node.parent) {
      expect(node.props.onPress).toBeUndefined();
      expect(node.props.accessibilityRole).toBeUndefined();
    }

    const buttons = renderer.root.findAll(node => node.props.accessibilityRole === 'button');
    expect(buttons.map(node => node.props.accessibilityLabel)).toEqual([
      i18n.t('chat.messageActions.edit'),
    ]);
  });

  it('opens the editor from the section action', () => {
    const renderer = renderNotes(NOTES);

    const edit = renderer.root.find(
      node =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === i18n.t('chat.messageActions.edit')
    );
    act(() => {
      (edit.props.onPress as () => void)();
    });

    const input = renderer.root.find(node => isHost(node, 'TextInput'));
    expect(input.props.accessibilityLabel).toBe(i18n.t('todos.item.notes'));
    expect(renderer.root.findAll(node => isHost(node, 'MarkdownText'))).toHaveLength(0);
  });

  it('keeps the empty-state prompt as its own button that opens the editor', () => {
    const renderer = renderNotes('');

    expect(renderer.root.findAll(node => isHost(node, 'MarkdownText'))).toHaveLength(0);
    const prompt = pressableAround(renderer.root, i18n.t('todos.item.notesPrompt'));
    act(() => {
      (prompt.props.onPress as () => void)();
    });

    expect(renderer.root.find(node => isHost(node, 'TextInput')).props.accessibilityLabel).toBe(
      i18n.t('todos.item.notes')
    );
  });
});
