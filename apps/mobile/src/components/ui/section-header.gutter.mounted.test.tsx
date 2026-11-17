import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SectionHeader } from './section-header';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

describe('SectionHeader gutter', () => {
  // A section header inside a padded body adds no inset of its own; a
  // full-bleed list passes `inset` so the label lines up with its rows.
  it('draws the page gutter only for a full-bleed list', () => {
    const rowClasses = (inset: boolean) => {
      // The renderer lives in a holder: the assignment happens inside the `act`
      // callback, which control-flow analysis does not follow, so a bare `let`
      // reads as never-assigned.
      const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
      act(() => {
        mounted.renderer = TestRenderer.create(createElement(SectionHeader, { label: 'Explore', inset }));
      });
      const renderer = mounted.renderer;
      if (!renderer) {
        throw new Error('Missing SectionHeader renderer');
      }
      const row = renderer.root.find(node => Object.is(node.type, 'View'));
      const classes = String(row.props.className).split(' ');
      act(() => renderer.unmount());
      return classes;
    };

    expect(rowClasses(false)).not.toContain('px-4');
    expect(rowClasses(true)).toContain('px-4');
  });
});
