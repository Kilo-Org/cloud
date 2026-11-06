// Tap geometry of the Up Next row's trailing start/open control: the size
// audit measures the frame a control renders, so the frame is the shared 48dp
// `ICON_TARGET_BOX_CLASS` while the visible circle inside it stays compact.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { UpNextSection } from './up-next-section';

const state = vi.hoisted(() => ({
  items: [
    {
      id: 'todo-1',
      listId: 'list-1',
      title: 'First task',
      listName: 'Backlog',
      listEmoji: null,
      sessions: [{ sessionId: 'session-1' }],
    },
    {
      id: 'todo-2',
      listId: 'list-1',
      title: 'Second task',
      listName: 'Backlog',
      listEmoji: null,
      sessions: [],
    },
  ],
  push: vi.fn(),
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/todos/use-start-todo', () => ({
  useStartTodo: () => ({ review: vi.fn(), startNow: vi.fn(), startingTodoId: null }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalArrowRight: 'DirectionalArrowRight',
}));
vi.mock('@/components/ui/icons', () => ({ ListTodo: 'ListTodo', Play: 'Play' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-todos', () => ({
  useTodoLists: () => ({ data: [{ id: state.items[0]?.listId }] }),
  useUpNextTodos: () => ({ data: state.items }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/todos/todo-routes', () => ({
  todoItemPath: (itemId: string) => `/(app)/todos/item/${itemId}`,
}));
vi.mock('@/lib/utils', () => ({
  cn: (...inputs: string[][]) => inputs.flat().filter(Boolean).join(' '),
}));

/** The trailing action opens the newest session once one ran, and starts before that. */
const ACTION_LABEL: Record<string, true> = {
  'notifications.action.openSession': true,
  'agentChat.newSession.startSession': true,
};
const CIRCLE_CLASS = 'size-10 items-center justify-center rounded-full bg-secondary';

/** The row's own pressable is labelled with the item title, so only these two match. */
function trailingActions(root: ReactTestInstance): ReactTestInstance[] {
  return root
    .findAllByType('Pressable')
    .filter(node => ACTION_LABEL[String(node.props.accessibilityLabel)] === true);
}

describe('Up Next trailing control tap target', () => {
  let renderer: ReactTestRenderer | undefined = undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => {
      renderer = TestRenderer.create(
        createElement(UpNextSection, { enabled: true, organizationId: 'org-1' })
      );
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  /** The mounted tree, present for every test that reads it. */
  function mountedTree(): ReactTestInstance {
    if (!renderer) {
      throw new Error('The Up Next section has not mounted');
    }
    return renderer.root;
  }

  it('renders the shared 48dp frame as the audited control', () => {
    const actions = trailingActions(mountedTree());
    expect(actions).toHaveLength(state.items.length);
    for (const action of actions) {
      expect(String(action.props.className)).toContain(ICON_TARGET_BOX_CLASS);
      // The frame carries the target on its own node, so no hitSlop is needed.
      expect(action.props.hitSlop).toBeUndefined();
    }
  });

  it('keeps the visible circle compact inside the frame', () => {
    const circles = mountedTree()
      .findAllByType('View')
      .filter(node => node.props.className === CIRCLE_CLASS);
    expect(circles).toHaveLength(state.items.length);
  });
});
