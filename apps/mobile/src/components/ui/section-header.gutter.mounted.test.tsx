import { createElement } from 'react';
import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';
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
  it('draws the page gutter only for a full-bleed list', async () => {
    const rowClasses = async (inset: boolean): Promise<string[]> => {
      const renderer = await act(() =>
        TestRenderer.create(createElement(SectionHeader, { label: 'Explore', inset }))
      );
      const row = renderer.root.find((node: ReactTestInstance) => Object.is(node.type, 'View'));
      const classes = String(row.props.className).split(' ');
      await act(() => {
        renderer.unmount();
      });
      return classes;
    };

    expect(await rowClasses(false)).not.toContain('px-4');
    expect(await rowClasses(true)).toContain('px-4');
  });
});
