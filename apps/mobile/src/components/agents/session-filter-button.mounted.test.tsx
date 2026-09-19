// The header filter glyph is 20pt, so the Pressable's own box must carry the
// tap target: `hitSlop` widens the touch area but not the accessibility node
// bounds the explorer's tap-target audit measures. The audit flags a control
// below 28dp on a side; the box targets the repo's 44pt minimum (WCAG 2.5.8 AA).

import { type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { SessionFilterButton } from './session-filter-button';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#14130f',
    mutedForeground: '#6f6a61',
    primary: '#4f5a10',
    primaryForeground: '#ffffff',
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** The minimum box a pressable's className declares, in px. */
function declaredBoxSize(className: string): { width: number; height: number } {
  const read = (axis: 'h' | 'w') => {
    const match = new RegExp(`(?:min-)?${axis}-\\[(\\d+)px\\]`).exec(className);
    return match ? Number(match[1]) : 0;
  };
  return { width: read('w'), height: read('h') };
}

let mounted: ReactTestRenderer | undefined = undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountButton(activeCount: number): ReactTestRenderer {
  act(() => {
    mounted = TestRenderer.create(
      <SessionFilterButton activeCount={activeCount} onPress={vi.fn<() => void>()} />
    );
  });
  if (!mounted) {
    throw new Error('SessionFilterButton did not mount');
  }
  return mounted;
}

function filterPressable(renderer: ReactTestRenderer) {
  return renderer.root.find(node => node.type === ('Pressable' as ElementType));
}

describe('SessionFilterButton tap target', () => {
  it('carries at least 28dp on both sides with no filters applied', () => {
    const box = declaredBoxSize(String(filterPressable(mountButton(0)).props.className));
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
  });

  it('carries at least 28dp on both sides while the count badge shows', () => {
    const renderer = mountButton(2);
    const box = declaredBoxSize(String(filterPressable(renderer).props.className));
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(renderer.root.findByProps({ testID: 'session-filter-badge' })).toBeDefined();
  });
});
