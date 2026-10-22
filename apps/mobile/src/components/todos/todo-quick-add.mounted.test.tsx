import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { TodoQuickAdd } from './todo-quick-add';

const state = vi.hoisted(() => ({
  onAdd: vi.fn(),
}));

// `vi.mock` factories are hoisted above this file's static imports, so the React
// they need can only come from a dynamic import inside the factory.
vi.mock('react-native', async () => {
  const React = await import('react');
  function TestTextInput({
    onChangeText,
    ref,
    ...props
  }: Readonly<{
    onChangeText?: (value: string) => void;
    ref?: unknown;
    [key: string]: unknown;
  }>) {
    const [value, setValue] = React.useState('');
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
    I18nManager: { isRTL: false },
    Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
    Pressable: 'Pressable',
    TextInput: TestTextInput,
    View: 'View',
  };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', async () => {
  const React = await import('react');
  return {
    Button: ({ disabled, onPress, accessibilityLabel, children }: Record<string, unknown>) =>
      React.createElement('Button', { disabled, onPress, accessibilityLabel }, children as never),
  };
});
vi.mock('@/components/ui/accessible-status', async () => {
  const React = await import('react');
  return {
    AccessibleStatus: ({ message }: Readonly<{ message: string | null }>) =>
      message === null ? null : React.createElement('AccessibleStatus', null, message),
  };
});
vi.mock('@/components/ui/icons', () => ({ Plus: 'Plus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#ffffff' }),
}));

type InputProps = { value: string; onChangeText: (text: string) => void };
type ButtonProps = { disabled: boolean; onPress: () => void };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderedTree() {
  if (!renderer) {
    throw new Error('The quick add row has not mounted');
  }
  return renderer.root;
}

/** Host props reach the test renderer untyped; the row's controls are these. */
function inputField() {
  return renderedTree().find(
    node => (node.type as string) === 'TextInput' && node.props.accessibilityLabel !== undefined
  ).props as InputProps;
}

function addButton() {
  return renderedTree().findByType('Button').props as ButtonProps;
}

function errorLine(): string | null {
  const status = renderedTree().findAllByType('AccessibleStatus').at(0);
  if (!status) {
    return null;
  }
  return status.children.map(child => (typeof child === 'string' ? child : '')).join('');
}

function type(value: string) {
  act(() => {
    inputField().onChangeText(value);
  });
}

/** Press Add and let the promise work it started settle inside act. */
async function pressAdd() {
  const button = addButton();
  await act(async () => {
    button.onPress();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  state.onAdd.mockReset();
  act(() => {
    renderer = TestRenderer.create(createElement(TodoQuickAdd, { onAdd: state.onAdd }));
  });
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('To-do quick add', () => {
  it('clears the field only once the add is confirmed', async () => {
    const pending = Promise.withResolvers<undefined>();
    state.onAdd.mockReturnValueOnce(pending.promise);
    type('Buy milk');

    act(() => {
      addButton().onPress();
    });

    expect(state.onAdd).toHaveBeenCalledExactlyOnceWith('Buy milk');
    expect(inputField().value).toBe('Buy milk');
    expect(addButton().disabled).toBe(true);

    await act(async () => {
      pending.resolve(undefined);
      await Promise.resolve();
    });

    expect(inputField().value).toBe('');
    expect(errorLine()).toBeNull();
    expect(addButton().disabled).toBe(true);
  });

  it('keeps the typed title with an error when the add fails', async () => {
    state.onAdd.mockRejectedValueOnce(new Error('offline'));
    type('Buy milk');

    await pressAdd();

    expect(inputField().value).toBe('Buy milk');
    expect(errorLine()).toBe(i18n.t('todos.list.addFailed'));
    expect(addButton().disabled).toBe(false);

    state.onAdd.mockResolvedValueOnce(undefined);
    await pressAdd();

    expect(state.onAdd).toHaveBeenCalledTimes(2);
    expect(inputField().value).toBe('');
    expect(errorLine()).toBeNull();
  });

  it('sends one add when pressed again while the first is in flight', async () => {
    const pending = Promise.withResolvers<undefined>();
    state.onAdd.mockReturnValueOnce(pending.promise);
    type('Buy milk');

    await act(async () => {
      const button = addButton();
      button.onPress();
      button.onPress();
      await Promise.resolve();
    });

    expect(state.onAdd).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(undefined);
      await Promise.resolve();
    });
  });
});
