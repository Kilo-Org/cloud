import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type TodoList } from '@/lib/todos/todo-types';
import { act, TestRenderer } from '@/test/renderer';

import { TodoListSettingsSheet } from './todo-list-settings-sheet';

const state = vi.hoisted(() => ({
  list: undefined as TodoList | undefined,
  update: vi.fn(),
  create: vi.fn(),
  back: vi.fn(),
}));

// The mutations this sheet consumes are pure state machines here: `isPending`
// flips inside `mutateAsync`, so the header's disabled state is driven the way
// the real mutation drives it.
// `vi.mock` factories are hoisted above this file's static imports, so the React
// they need can only come from a dynamic import inside the factory.
vi.mock('@/lib/hooks/use-todos', async () => {
  const React = await import('react');
  function useFakeMutation(kind: 'update' | 'create') {
    const [isPending, setPending] = React.useState(false);
    const run = kind === 'update' ? state.update : state.create;
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
    useTodoLists: () => ({ data: state.list ? [state.list] : [], isSuccess: true }),
    useTodoListMutations: () => ({
      update: useFakeMutation('update'),
      create: useFakeMutation('create'),
    }),
  };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: state.back, push: vi.fn() }),
  useFocusEffect: () => undefined,
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  function TestTextInput({
    defaultValue = '',
    onChangeText,
    ref,
    ...props
  }: Readonly<{
    defaultValue?: string;
    onChangeText?: (value: string) => void;
    ref?: unknown;
    [key: string]: unknown;
  }>) {
    const [value, setValue] = React.useState(defaultValue);
    React.useImperativeHandle(
      ref as never,
      () => ({
        clear: () => {
          setValue('');
        },
      }),
      []
    );
    return React.createElement('TextInput', {
      ...props,
      value,
      onChangeText: (next: string) => {
        setValue(next);
        onChangeText?.(next);
      },
    });
  }
  return {
    BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    I18nManager: { isRTL: false },
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: TestTextInput,
    View: 'View',
  };
});
vi.mock('@/components/sheet-header', async () => {
  const React = await import('react');
  return {
    SheetHeader: (props: Record<string, unknown>) => React.createElement('SheetHeader', props),
  };
});
vi.mock('@/components/ui/use-sheet-dismiss-guard', () => ({
  useSheetDismissGuard: () => ({ requestClose: vi.fn(), requestDismiss: () => true, dialog: null }),
}));
vi.mock('@/components/agents/mode-selector', () => ({ ModeSelector: 'ModeSelector' }));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/agents/repo-selector', () => ({ RepoSelector: 'RepoSelector' }));
vi.mock('@/lib/use-new-session-repos', () => ({
  useNewSessionRepos: () => ({ repositories: [], recents: [], groups: [] }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#666666' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/accessible-status', async () => {
  const React = await import('react');
  return {
    AccessibleStatus: ({ message }: Readonly<{ message: string | null }>) =>
      message === null ? null : React.createElement('AccessibleStatus', null, message),
  };
});
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', async () => {
  const React = await import('react');
  return {
    EmptyState: ({ title, description }: Readonly<{ title: string; description?: string }>) =>
      React.createElement('EmptyState', { title }, description ?? null),
  };
});
vi.mock('@/components/ui/icons', () => ({ Info: 'Info' }));

const list: TodoList = {
  id: 'test-list',
  organizationId: null,
  name: 'Saved name',
  emoji: null,
  gitUrl: null,
  mode: null,
  model: null,
  variant: null,
  position: 'a',
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  openCount: 0,
};

type HeaderProps = { onDone: () => void; disabled?: boolean; doneDisabled?: boolean };
type TextInputProps = { value: string; onChangeText: (text: string) => void };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderedTree() {
  if (!renderer) {
    throw new Error('The list settings sheet has not mounted');
  }
  return renderer.root;
}

/** Host props reach the test renderer untyped; the sheet's controls are these. */
function header() {
  return renderedTree().findByType('SheetHeader').props as HeaderProps;
}

function errorLine(): string | null {
  const status = renderedTree().findAllByType('AccessibleStatus').at(0);
  if (!status) {
    return null;
  }
  return status.children.map(child => (typeof child === 'string' ? child : '')).join('');
}

function nameInput() {
  return renderedTree().find(
    node =>
      (node.type as string) === 'TextInput' &&
      node.props.accessibilityLabel === i18n.t('todos.listSettings.name')
  ).props as TextInputProps;
}

function mount(listValue: TodoList | null) {
  state.list = listValue ?? undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(TodoListSettingsSheet, {
        listId: listValue ? listValue.id : null,
        organizationId: null,
      })
    );
  });
}

/** Run one interaction, then let the promise work it started settle inside act. */
async function settle(interaction: () => void) {
  await act(async () => {
    interaction();
    await Promise.resolve();
  });
}

async function pressDone() {
  const sheet = header();
  expect(sheet.disabled).not.toBe(true);
  await settle(() => {
    sheet.onDone();
  });
}

/** A mutation call that settles only when the test says so. */
function deferred() {
  return Promise.withResolvers<unknown>();
}

beforeEach(async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  state.list = undefined;
  state.update.mockReset();
  state.create.mockReset();
  state.back.mockReset();
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('To-do list settings save', () => {
  it('keeps the sheet open with an error when the update fails', async () => {
    state.update.mockRejectedValueOnce(new Error('offline'));
    mount(list);
    act(() => {
      nameInput().onChangeText('Renamed list');
    });

    await pressDone();

    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      id: 'test-list',
      name: 'Renamed list',
      emoji: null,
      gitUrl: null,
      mode: null,
      model: null,
      variant: null,
    });
    expect(state.back).not.toHaveBeenCalled();
    expect(errorLine()).toBe(i18n.t('todos.listSettings.saveFailed'));
    expect(nameInput().value).toBe('Renamed list');
  });

  it('closes only after the update resolves, and disables the header meanwhile', async () => {
    const pending = deferred();
    state.update.mockReturnValueOnce(pending.promise);
    mount(list);
    act(() => {
      nameInput().onChangeText('Renamed list');
    });

    await settle(() => {
      header().onDone();
    });

    expect(state.back).not.toHaveBeenCalled();
    expect(header().disabled).toBe(true);
    expect(header().doneDisabled).toBe(true);

    await settle(() => {
      pending.resolve(undefined);
    });

    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('sends one update when Done is pressed twice while it is in flight', async () => {
    const pending = deferred();
    state.update.mockReturnValueOnce(pending.promise);
    mount(list);
    act(() => {
      nameInput().onChangeText('Renamed list');
    });

    await settle(() => {
      const sheet = header();
      sheet.onDone();
      sheet.onDone();
    });

    expect(state.update).toHaveBeenCalledTimes(1);

    await settle(() => {
      pending.resolve(undefined);
    });

    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed new list on the form and saves it on retry', async () => {
    state.create.mockRejectedValueOnce(new Error('offline'));
    mount(null);
    act(() => {
      nameInput().onChangeText('New list');
    });

    await pressDone();

    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      organizationId: null,
      name: 'New list',
      emoji: null,
      gitUrl: null,
      mode: null,
      model: null,
      variant: null,
    });
    expect(state.back).not.toHaveBeenCalled();
    expect(errorLine()).toBe(i18n.t('todos.listSettings.saveFailed'));

    await pressDone();

    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.back).toHaveBeenCalledTimes(1);
    expect(errorLine()).toBeNull();
  });
});
