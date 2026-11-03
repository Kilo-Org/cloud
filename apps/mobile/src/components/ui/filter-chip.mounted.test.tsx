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

/** The chip's props, read once so the assertions stay typed. */
type ChipProps = { className?: string; accessibilityState?: { selected?: boolean } };

function chipProps(node: TestRenderer.ReactTestInstance): ChipProps {
  return node.props as ChipProps;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(selected: boolean): TestRenderer.ReactTestInstance {
  act(() => {
    if (renderer) {
      renderer.update(createElement(FilterChip, { selected, label: 'Balance' }));
    } else {
      renderer = TestRenderer.create(
        createElement(FilterChip, {
          selected,
          label: 'Balance',
          accessibilityState: { selected },
          onPress: () => undefined,
        })
      );
    }
  });
  if (!renderer) {
    throw new Error('Missing FilterChip renderer');
  }
  return renderer.root;
}

/**
 * Selecting a chip only switched `secondary` over `ghost`, which drew a 1.1:1
 * fill and kept the label colour, so the current filter reached assistive tech
 * but not the screen. The selected option now keeps the neutral surface and
 * default label ink, and adds a muted neutral ring over its edge, so it reads
 * as selected without spending the brand `primary` ink that the page's primary
 * action owns.
 */
it('rings the selected chip with a muted neutral edge, keeping its surface and label ink', () => {
  const root = render(true);
  const chip = chipProps(root.findByType(Pressable));
  expect(chip.className).toContain('bg-secondary');
  expect(chip.className).not.toContain('bg-primary');
  expect(chip.accessibilityState?.selected).toBe(true);
  // The label keeps the surface's neutral ink; only the ring carries the selection.
  const labelClass = chipProps(root.findByType('Text')).className ?? '';
  expect(labelClass).toContain('text-secondary-foreground');
  expect(labelClass).not.toContain('text-primary');

  const rings = root.findAllByType('View');
  expect(rings).toHaveLength(1);
  const ring = chipProps(rings[0] as TestRenderer.ReactTestInstance).className ?? '';
  expect(ring).toContain('border-muted-foreground');
  expect(ring).not.toContain('border-primary');
  // An overlay, so the ring never changes the chip's size or the row's frames.
  expect(ring).toContain('absolute');
  expect(ring).toContain('inset-0');
});

it('leaves the unselected chip unpainted and unringed', () => {
  const root = render(false);
  const chip = chipProps(root.findByType(Pressable));
  expect(chip.className).not.toContain('bg-secondary');
  expect(chip.className).not.toContain('bg-primary');
  expect(root.findAllByType('View')).toHaveLength(0);
  expect(chipProps(root.findByType('Text')).className ?? '').not.toContain('text-primary');
  expect(chip.accessibilityState?.selected).toBe(false);
});

/** Moving the selection repaints the same chip instead of resizing it. */
it('keeps one chip of the same size across both states', () => {
  const selected = chipProps(render(true).findByType(Pressable)).className ?? '';
  const unselected = chipProps(render(false).findByType(Pressable)).className ?? '';
  expect(selected).toMatch(/min-h-\[36px\]/);
  expect(unselected).toMatch(/min-h-\[36px\]/);
  expect(selected).not.toMatch(/\bborder\b/);
  expect(unselected).not.toMatch(/\bborder\b/);
});

/** A caller's `accessibilityState` cannot disagree with the painted state. */
it('announces the chip it painted, whatever the caller passed', () => {
  act(() => {
    renderer = TestRenderer.create(
      createElement(FilterChip, {
        selected: true,
        label: 'Balance',
        accessibilityState: { selected: false },
        onPress: () => undefined,
      })
    );
  });
  if (!renderer) {
    throw new Error('Missing FilterChip renderer');
  }
  expect(chipProps(renderer.root.findByType(Pressable)).accessibilityState?.selected).toBe(true);
});
