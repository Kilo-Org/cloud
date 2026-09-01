import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SheetHeader } from './sheet-header';
import '@/i18n';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827' }),
}));

const mounts: Awaited<ReturnType<typeof renderWithProviders>>[] = [];

async function mount(props: Parameters<typeof SheetHeader>[0]) {
  const result = await renderWithProviders(createElement(SheetHeader, props));
  mounts.push(result);
  return result.renderer;
}

afterEach(() => {
  for (const result of mounts) {
    result.unmount();
  }
  mounts.length = 0;
});

describe('SheetHeader title layout', () => {
  it.each([undefined, false])(
    'bounds the title to two lines when wrapTitle is %s',
    async wrapTitle => {
      const renderer = await mount({
        title: 'Inspect performance child 01',
        onDone: () => undefined,
        wrapTitle,
      });
      const heading = renderer.root.findByProps({ accessibilityRole: 'header' });

      expect(heading.props.children).toBe('Inspect performance child 01');
      expect(heading.props.numberOfLines).toBe(2);
      expect(heading.parent?.props.className).toContain('min-h-11');
    }
  );

  it('centers the full title above the controls without overlap', async () => {
    const onDone = vi.fn<() => void>();
    const renderer = await mount({
      title: 'Inspect performance child 01',
      onDone,
      wrapTitle: true,
    });
    const heading = renderer.root.findByProps({ accessibilityRole: 'header' });
    const titleRegion = heading.parent;
    const header = titleRegion?.parent;
    const dones = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Done'
    );

    expect(heading.props.children).toBe('Inspect performance child 01');
    expect.soft(heading.props.numberOfLines).toBeUndefined();
    expect.soft(titleRegion?.props.className).toContain('min-h-11');
    expect.soft(titleRegion?.props.className).not.toMatch(/(?:^|\s)(?:h-|max-h-|overflow-hidden)/u);
    expect(heading.props.className).toContain('w-full');
    expect(heading.props.className).toContain('text-center');
    expect(heading.props.className).toContain('text-lg');
    expect(heading.props.adjustsFontSizeToFit).not.toBe(true);
    expect(header?.props.collapsable).toBe(false);
    expect(dones).toHaveLength(1);
    expect(dones[0]?.parent).not.toBe(titleRegion);
    expect(dones[0]?.parent?.parent).toBe(header);
    expect(dones[0]?.props.className).toContain('ms-auto');
    expect(dones[0]?.props.className).not.toContain('absolute');
    expect(dones[0]?.props.onPress).toBe(onDone);
    expect(dones[0]?.props.disabled).toBe(false);
  });
});
