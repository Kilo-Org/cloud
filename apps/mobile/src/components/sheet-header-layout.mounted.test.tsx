import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SheetHeader } from './sheet-header';
import '@/i18n';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StatusBar: { currentHeight: 0 },
  View: 'View',
}));
// SheetHeader reads the landscape side insets; this suite mounts without a
// device, so the hook gets portrait-zero insets (same pattern as
// sheet-header.mounted.test.tsx).
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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

  it('draws the trailing Done as the same rounded control as Cancel, not a filled circle', async () => {
    const renderer = await mount({
      title: 'Language',
      onDone: () => undefined,
      onCancel: () => undefined,
    });
    const done = pressablesByLabel(renderer.root, 'Done')[0];
    const cancel = pressablesByLabel(renderer.root, 'Cancel')[0];
    const doneClasses = String(done?.props.className);
    const cancelClasses = String(cancel?.props.className);

    for (const control of [doneClasses, cancelClasses]) {
      // Both are the same unfilled rounded rectangle: the identical shape
      // classes and no surface behind either label, so the trailing control
      // carries no more weight than the plain-text one beside it.
      expect(control).toContain('rounded-md');
      expect(control).toContain('min-h-11 min-w-11');
      expect(control).not.toMatch(/rounded-full|bg-/);
    }
    // Done differs from Cancel only by where it sits and how it animates.
    expect(doneClasses.replace('ms-auto ', '').replace(' will-change-pressable', '')).toBe(
      cancelClasses
    );

    renderer.unmount();
  });
});
