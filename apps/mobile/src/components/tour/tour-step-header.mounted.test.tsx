import { createElement, type ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { TOUR_HEADER_MAX_FONT_SCALE } from './tour-font-scale';
import { TourStepHeader } from './tour-step-header';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

async function mountHeader() {
  const mounted = await renderWithProviders(
    createElement(TourStepHeader, {
      icon: 'step-icon',
      title: 'step title',
      body: 'step body',
    })
  );
  return mounted;
}

describe('TourStepHeader', () => {
  it('renders the icon tile, the h3 title and the muted body', async () => {
    const { renderer, unmount } = await mountHeader();
    const texts = renderer.root.findAllByType('Text' as ElementType);
    expect(texts.map(node => node.props.children)).toEqual(['step title', 'step body']);
    expect(texts[0]?.props.variant).toBe('h3');
    expect(texts[1]?.props.variant).toBe('muted');
    const [tile] = renderer.root.findAllByType('View' as ElementType);
    expect(tile?.children).toContainEqual('step-icon');
    unmount();
  });

  // p16: on a small screen at a large system font the whole header block must
  // fit above the scroll fold, so the body's last line is never cut mid-glyph
  // above the Skip/Done bar. Both texts carry the shared cap.
  it('caps the title and body font scale at the tour header maximum', async () => {
    const { renderer, unmount } = await mountHeader();
    const texts = renderer.root.findAllByType('Text' as ElementType);
    expect(texts).toHaveLength(2);
    for (const node of texts) {
      expect(node.props.maxFontSizeMultiplier).toBe(TOUR_HEADER_MAX_FONT_SCALE);
    }
    unmount();
  });
});
