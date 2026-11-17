import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { TOUR_HEADER_MAX_FONT_SCALE } from './tour-font-scale';
import { TourStepHeader } from './tour-step-header';

// Only the platform primitives and the slot package are mocked: the shared
// `Text` (and the `Eyebrow` over it) mounts for real, so the heading role and
// level the header's variants ask for are the primitive's behavior here rather
// than a copy of the props this file passes.
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

async function mountHeader() {
  const mounted = await renderWithProviders(
    createElement(TourStepHeader, {
      icon: 'step-icon',
      eyebrow: 'step eyebrow',
      title: 'step title',
      body: 'step body',
    })
  );
  return mounted;
}

describe('TourStepHeader', () => {
  // A `Text` node's element type is the host string the primitive renders, so
  // these are the nodes the platform draws.
  it('renders the eyebrow, the title and the body under the icon', async () => {
    const { renderer, unmount } = await mountHeader();
    const texts = renderer.root.findAllByType('Text');
    expect(texts.map(node => node.props.children)).toEqual([
      'step eyebrow',
      'step title',
      'step body',
    ]);

    // The title keeps the heading role: an assistive reader navigates by
    // headings, and the tour's title lives in the content, not a screen header.
    // Its type is still a Text variant, not a one-off heading level.
    const [eyebrow, title] = texts;
    expect(title?.props.accessibilityRole).toBe('header');
    expect(eyebrow?.props.accessibilityRole).toBeUndefined();
    expect(title?.props.className).toContain('text-lg');

    // The icon precedes the copy block, and the text above is all that block
    // holds: the step header draws no tile of its own.
    const views = renderer.root.findAllByType('View');
    expect(views).toHaveLength(1);
    unmount();
  });

  // p16: on a small screen at a large system font the whole header block must
  // fit above the scroll fold, so the body's last line is never cut mid-glyph
  // above the Skip/Done bar. The eyebrow joins the title and body under the
  // same shared cap. Outside the system font-scale provider the primitive has
  // no live scale to track, so the cap the header passes reaches the platform.
  it('caps the eyebrow, title and body font scale at the tour header maximum', async () => {
    const { renderer, unmount } = await mountHeader();
    const texts = renderer.root.findAllByType('Text');
    expect(texts).toHaveLength(3);
    for (const node of texts) {
      expect(node.props.maxFontSizeMultiplier).toBe(TOUR_HEADER_MAX_FONT_SCALE);
    }
    unmount();
  });
});
