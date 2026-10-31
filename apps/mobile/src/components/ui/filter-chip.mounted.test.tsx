import { createElement } from 'react';
import { Pressable } from 'react-native';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { FilterChip } from './filter-chip';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#123456',
    primary: '#345678',
    primaryForeground: '#abcdef',
  }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function chip(selected: boolean): TestRenderer.ReactTestInstance {
  act(() => {
    if (renderer) {
      renderer.update(createElement(FilterChip, { selected, accessibilityLabel: 'Balance' }));
    } else {
      renderer = TestRenderer.create(
        createElement(FilterChip, {
          selected,
          accessibilityState: { selected },
          accessibilityLabel: 'Balance',
          onPress: () => undefined,
        })
      );
    }
  });
  if (!renderer) {
    throw new Error('Missing FilterChip renderer');
  }
  return renderer.root.findByType(Pressable);
}

/**
 * The chip's whole visible selection signal is its fill: `secondary` over
 * `ghost` drew a 1.1:1 difference and left the label colour alone, so the
 * current filter was announced to assistive tech only. The selected chip must
 * keep the primary fill, and the unselected one must stay unpainted.
 */
it('paints the selected chip with the primary fill and leaves the rest transparent', () => {
  const selected = chip(true);
  expect(selected.props.className).toContain('bg-primary');
  expect(selected.props.className).not.toContain('bg-secondary');

  const unselected = chip(false);
  expect(unselected.props.className).not.toContain('bg-primary');
  expect(unselected.props.className).not.toContain('bg-secondary');
});
