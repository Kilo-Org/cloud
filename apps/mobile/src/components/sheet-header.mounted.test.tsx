/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/accessible-status.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SheetHeader } from './sheet-header';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827' }),
}));

async function mount(
  props: ComponentProps<typeof SheetHeader>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(SheetHeader, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function pressablesByLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === label
  );
}

describe('SheetHeader share action', () => {
  it('renders a Share pressable in the left slot when onShare is provided', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onShare: () => undefined,
    });

    const shares = pressablesByLabel(renderer.root, 'Share report.pdf');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.props.accessibilityRole).toBe('button');
    expect(shares[0]?.props.disabled).toBe(false);

    renderer.unmount();
  });

  it('disables the Share pressable while sharing', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onShare: () => undefined,
      sharing: true,
    });

    const shares = pressablesByLabel(renderer.root, 'Share report.pdf');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.props.disabled).toBe(true);

    renderer.unmount();
  });

  it('renders no Share pressable without onShare and keeps the Done button', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
    });

    expect(pressablesByLabel(renderer.root, 'Share report.pdf')).toHaveLength(0);
    expect(pressablesByLabel(renderer.root, 'Done')).toHaveLength(1);

    renderer.unmount();
  });
});
