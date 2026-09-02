/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as sheet-header.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SheetHeader } from './sheet-header';
import '@/i18n';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827' }),
}));

async function mount(
  props: ComponentProps<typeof SheetHeader>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
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

describe('SheetHeader layout', () => {
  it.each([false, true])('keeps the title and Done on one row (Cancel=%s)', async withCancel => {
    const onCancel = withCancel ? () => undefined : undefined;
    const renderer = await mount({ title: 'Run on', onDone: () => undefined, onCancel });
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    const done = pressablesByLabel(renderer.root, 'Done')[0];
    const titleRegion = title.parent;
    const row = done?.parent;

    expect(row?.props.className).toContain('flex-row');
    expect(row?.props.className).not.toContain('flex-wrap');
    expect(row?.props.className).toContain('items-center');
    expect(title.props.ellipsizeMode).toBe('tail');
    expect(String(title.props.className).includes('text-center')).toBe(withCancel);
    expect(titleRegion?.props.className).toContain('min-w-0');
    expect(titleRegion?.parent).toBe(row);
    expect(done?.props.className).toContain('shrink-0');

    renderer.unmount();
  });
});
