import { type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Card } from './card';

// The node project never parses RN's Flow-typed sources, so the primitive's
// view becomes a string element (same pattern as segmented-control.test.ts).
vi.mock('react-native', () => ({ View: 'View' }));

type CardElement = { props?: { className?: string } };

function cardClasses(props: Parameters<typeof Card>[0]): string[] {
  // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
  const element = Card(props) as ReactElement;
  return String((element as unknown as CardElement).props?.className).split(' ');
}

describe('Card', () => {
  it('draws the padded content block by default', () => {
    const classes = cardClasses({ children: 'Balance' });

    expect(classes).toEqual(expect.arrayContaining(['rounded-xl', 'bg-secondary', 'p-4', 'gap-3']));
    expect(classes).not.toContain('overflow-hidden');
  });

  // Layered content (a home card's live and reserved layers) draws its own rows
  // and their padding, so the card must not add a second inset or a gap the
  // layers do not own; it only supplies the surface and clips to its radius.
  it('draws a padless surface that clips its full-bleed layers', () => {
    const classes = cardClasses({ children: 'Layers', padding: 'none' });

    expect(classes).toEqual(expect.arrayContaining(['rounded-xl', 'bg-secondary', 'overflow-hidden']));
    expect(classes).not.toContain('p-4');
    expect(classes).not.toContain('gap-3');
  });

  it('keeps a caller layout class beside the surface', () => {
    const classes = cardClasses({ children: 'Layers', padding: 'none', className: 'flex-row' });

    expect(classes).toEqual(expect.arrayContaining(['flex-row', 'rounded-xl', 'bg-secondary']));
  });
});
