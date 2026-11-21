import { createElement } from 'react';
import { type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { SelectableText } from './selectable-text';

// Mutable so one test renders the Android branch and the next the iOS one: the
// component reads `Platform.OS` on every render.
const platform = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));

vi.mock('react-native', () => ({
  Platform: platform,
  TextInput: 'TextInput',
}));
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide its host name
// as a marker and a real context, so `SelectableText` can call
// `useContext(TextClassContext)` and render `<Text>` on the static branch.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});

function findHost(
  renderer: TestRenderer.ReactTestRenderer,
  type: 'Text' | 'TextInput'
): TestRenderer.ReactTestInstance | undefined {
  const hosts = renderer.root.findAll(node => (node.type as string) === type);
  return hosts[0];
}

/** Sentinel whose identity the test asserts reaches the platform host. */
const sentinelOnLayout = () => undefined;

async function renderSelectableText(
  children: string,
  options: {
    onLayout?: (event: LayoutChangeEvent) => void;
    style?: StyleProp<TextStyle>;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  } = {}
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      // eslint-disable-next-line react/no-children-prop -- tsgo requires `children` in the props object, not the third argument.
      createElement(SelectableText, { children, ...options })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('SelectableText mounted', () => {
  beforeEach(() => {
    platform.OS = 'ios';
  });

  it('renders a read-only multiline TextInput with the passed text as value', async () => {
    const renderer = await renderSelectableText('hello world');

    const input = findHost(renderer, 'TextInput');
    expect(input).toBeDefined();
    expect(input?.props.editable).toBe(false);
    expect(input?.props.multiline).toBe(true);
    expect(input?.props.scrollEnabled).toBe(false);
    // Native selection must not be suppressed or overridden.
    expect(input?.props.contextMenuHidden).toBeUndefined();
    expect(input?.props.accessibilityRole).toBeUndefined();
    // Text flows through `value`, not `defaultValue` (streaming parts re-resolve).
    expect(input?.props.value).toBe('hello world');
  });

  it('keeps the shared Text weight and zero padding in the class string', async () => {
    const renderer = await renderSelectableText('styled');

    const className = findHost(renderer, 'TextInput')?.props.className as string;
    expect(className).toContain('font-medium');
    expect(className).toContain('p-0');
  });

  it('updates the value when children change instead of freezing the first value', async () => {
    const renderer = await renderSelectableText('first');
    expect(findHost(renderer, 'TextInput')?.props.value).toBe('first');

    await act(async () => {
      await Promise.resolve();
      // eslint-disable-next-line react/no-children-prop -- tsgo requires `children` in the props object, not the third argument.
      renderer.update(createElement(SelectableText, { children: 'second' }));
    });
    expect(findHost(renderer, 'TextInput')?.props.value).toBe('second');
  });

  it('forwards the caller onLayout to the TextInput host', async () => {
    const renderer = await renderSelectableText('measured', { onLayout: sentinelOnLayout });

    // Same reference, so the mono block height pin stays wired to real layout.
    expect(findHost(renderer, 'TextInput')?.props.onLayout).toBe(sentinelOnLayout);
  });

  it('forwards the caller style to the TextInput host beside the class string', async () => {
    const style = { direction: 'ltr', writingDirection: 'ltr', textAlign: 'right' } as const;
    const renderer = await renderSelectableText('الجلسة', { style });

    const input = findHost(renderer, 'TextInput');
    expect(input?.props.style).toEqual(style);
    // The class string still compiles the shared text treatment.
    expect(input?.props.className).toContain('font-medium');
  });
});

describe('SelectableText on Android', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('renders static selectable Text with the value and the caller props', async () => {
    const style = { direction: 'ltr', writingDirection: 'ltr', textAlign: 'right' } as const;
    const renderer = await renderSelectableText('قيمة للنسخ', {
      onLayout: sentinelOnLayout,
      style,
      accessibilityLabel: 'Selected command',
      accessibilityHint: 'Copies the value',
    });

    const text = findHost(renderer, 'Text');
    expect(text).toBeDefined();
    expect(text?.props.selectable).toBe(true);
    expect(text?.props.children).toBe('قيمة للنسخ');
    expect(text?.props.onLayout).toBe(sentinelOnLayout);
    expect(text?.props.style).toEqual(style);
    expect(text?.props.accessibilityLabel).toBe('Selected command');
    expect(text?.props.accessibilityHint).toBe('Copies the value');
    // Static text stays text: no role may make TalkBack announce a field or a
    // button, and no EditText is rendered at all.
    expect(text?.props.accessibilityRole).toBeUndefined();
    expect(findHost(renderer, 'TextInput')).toBeUndefined();
  });

  it('keeps the shared Text weight in the class string on the static branch', async () => {
    const renderer = await renderSelectableText('styled');

    const className = findHost(renderer, 'Text')?.props.className as string;
    expect(className).toContain('font-medium');
    expect(className).toContain('p-0');
  });
});
