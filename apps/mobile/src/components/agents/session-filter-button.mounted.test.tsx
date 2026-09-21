import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionFilterButton } from './session-filter-button';
import { COMPACT_CONTROL_FRAME_DP, COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/touch-target';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#ffffff', mutedForeground: '#6F6A61' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function mount(activeCount: number): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(SessionFilterButton, {
        activeCount,
        onPress: vi.fn<() => void>(),
        testID: 'agents-open-filters',
      })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- act() may not assign
  if (!renderer) {
    throw new Error('SessionFilterButton did not mount');
  }
  return renderer;
}

function findButton(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.testID === 'agents-open-filters'
  );
}

describe('SessionFilterButton touch target', () => {
  it('measures the frame, not the 20pt glyph, and reaches 44pt with its slop', () => {
    const renderer = mount(0);
    const button = findButton(renderer);

    // A size audit measures the frame a control renders; sized to its glyph
    // this control reported 20dp and was rejected as too small to tap.
    // `h-11 w-11` is the frame the header's own controls use.
    expect(button.props.className).toContain('h-11 w-11');
    expect(button.props.className).toContain('items-center');
    expect(button.props.className).toContain('justify-center');

    // The rendered slop, on top of the documented frame, is the 44pt target.
    const hitSlop = button.props.hitSlop as number;
    expect(hitSlop).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    expect(COMPACT_CONTROL_FRAME_DP + 2 * hitSlop).toBeGreaterThanOrEqual(44);

    renderer.unmount();
  });

  it('keeps the badge on the glyph corner inside the bigger frame', () => {
    const renderer = mount(2);
    const badge = renderer.root.find(
      node => typeof node.type === 'string' && node.props.testID === 'session-filter-badge'
    );

    expect(badge.children).toEqual(['2']);
    // The badge hangs off the glyph's 20pt box, not off the 38.5pt Pressable.
    const badgeBox = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        String(node.props.className).includes('absolute') &&
        String(node.props.className).includes('-right-1.5')
    );
    expect(badgeBox.parent?.type).toBe('View');
    expect(badgeBox.parent?.props.className).toBeUndefined();

    renderer.unmount();
  });
});
