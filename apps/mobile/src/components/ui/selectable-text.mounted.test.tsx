/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { type LayoutChangeEvent } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SelectableText } from './selectable-text';

vi.mock('react-native', () => ({
  TextInput: 'TextInput',
}));
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so `useContext(TextClassContext)` in `SelectableText` still resolves.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});

function findTextInput(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance | undefined {
  const hosts = renderer.root.findAll(node => (node.type as string) === 'TextInput');
  return hosts[0];
}

/** Sentinel whose identity the test asserts reaches the TextInput host. */
const sentinelOnLayout = () => undefined;

async function renderSelectableText(
  children: string,
  onLayout?: (event: LayoutChangeEvent) => void
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      // eslint-disable-next-line react/no-children-prop -- tsgo requires `children` in the props object, not the third argument.
      createElement(SelectableText, onLayout ? { children, onLayout } : { children })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('SelectableText mounted', () => {
  it('renders a read-only multiline TextInput with the passed text as value', async () => {
    const renderer = await renderSelectableText('hello world');

    const input = findTextInput(renderer);
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

    const className = findTextInput(renderer)?.props.className as string;
    expect(className).toContain('font-medium');
    expect(className).toContain('p-0');
  });

  it('updates the value when children change instead of freezing the first value', async () => {
    const renderer = await renderSelectableText('first');
    expect(findTextInput(renderer)?.props.value).toBe('first');

    await act(async () => {
      await Promise.resolve();
      // eslint-disable-next-line react/no-children-prop -- tsgo requires `children` in the props object, not the third argument.
      renderer.update(createElement(SelectableText, { children: 'second' }));
    });
    expect(findTextInput(renderer)?.props.value).toBe('second');
  });

  it('forwards the caller onLayout to the TextInput host', async () => {
    const renderer = await renderSelectableText('measured', sentinelOnLayout);

    // Same reference, so the mono block height pin stays wired to real layout.
    expect(findTextInput(renderer)?.props.onLayout).toBe(sentinelOnLayout);
  });
});
