// The card's reserved subtext row: the line the summary grid keeps for a
// card's subtext so the row below it does not move when the data arrives.
// `BackgroundChart` is mocked because it pulls in recharts, which this suite
// does not transform; the card renders no chart in these cases.

jest.mock('./BackgroundChart', () => ({ BackgroundChart: 'BackgroundChart' }));

import { createElement } from 'react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricCard } from './MetricCard';

// The web Jest transform compiles JSX with the classic runtime, so an app
// component written for Next.js's automatic runtime resolves `React` as a free
// variable at render time. Provide it for this render-only test.
(globalThis as { React?: typeof React }).React = React;

/** The reserved subtext row's class list, as `MetricCard` renders it. */
const RESERVED_ROW = 'text-muted-foreground mt-1 min-h-4 text-xs';

describe('MetricCard reserved subtext row', () => {
  it('keeps the row after loading finishes without a subtext', () => {
    const loading = renderToStaticMarkup(
      createElement(MetricCard, { title: 'Cost', value: '$1.00', loading: true })
    );
    const loaded = renderToStaticMarkup(
      createElement(MetricCard, { title: 'Cost', value: '$1.00' })
    );

    expect(loading).toContain(RESERVED_ROW);
    // Only a subset of the cards passes a subtext, so the row has to stay
    // after the data lands even when this card has none: dropping it there is
    // the 20px shrink that moved the summary row and everything below it.
    expect(loaded).toContain(RESERVED_ROW);
  });

  it('renders the subtext in the reserved row', () => {
    const html = renderToStaticMarkup(
      createElement(MetricCard, { title: 'Tokens', value: '1,000', subtext: 'of 2,000' })
    );

    expect(html).toContain(RESERVED_ROW);
    expect(html).toContain('of 2,000');
  });
});
