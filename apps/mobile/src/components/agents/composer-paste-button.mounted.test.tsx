/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as permission-card.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ComposerPasteButton } from './composer-paste-button';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
}));
vi.mock('@/components/ui/icons', () => ({
  ClipboardPaste: 'ClipboardPaste',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

type RenderProps = {
  onPress: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
};

function findPasteButton(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => node.props.accessibilityLabel === 'Paste from clipboard');
}

async function renderButton(props: RenderProps) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ComposerPasteButton, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ComposerPasteButton mounted', () => {
  it('renders an accessible button with the paste label', async () => {
    const renderer = await renderButton({ onPress: () => undefined });

    const node = findPasteButton(renderer.root);
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityLabel).toBe('Paste from clipboard');
  });

  it('maps disabled to the Pressable props and defaults to false when omitted', async () => {
    const renderer = await renderButton({ onPress: () => undefined, disabled: true });

    const node = findPasteButton(renderer.root);
    const accessibilityState = node.props.accessibilityState as { disabled: boolean };
    expect(node.props.disabled).toBe(true);
    expect(accessibilityState.disabled).toBe(true);

    const enabledRenderer = await renderButton({ onPress: () => undefined });
    const enabledNode = findPasteButton(enabledRenderer.root);
    const enabledAccessibilityState = enabledNode.props.accessibilityState as { disabled: boolean };
    expect(enabledNode.props.disabled).toBe(false);
    expect(enabledAccessibilityState.disabled).toBe(false);
  });

  it('invokes onPress when the button is pressed', async () => {
    const onPress = vi.fn(() => undefined);
    const renderer = await renderButton({ onPress });

    const node = findPasteButton(renderer.root);
    const handlePress = node.props.onPress as () => void;
    handlePress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('defaults to the md size classes and honors the sm size', async () => {
    const renderer = await renderButton({ onPress: () => undefined });

    const node = findPasteButton(renderer.root);
    expect(node.props.className).toContain('h-9 w-9');

    const smRenderer = await renderButton({ onPress: () => undefined, size: 'sm' });
    const smNode = findPasteButton(smRenderer.root);
    expect(smNode.props.className).toContain('h-8 w-8');
  });
});
