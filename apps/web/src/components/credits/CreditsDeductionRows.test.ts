import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreditsDeductionRows } from './CreditsDeductionRows';
import type { DeductionGroup } from '@/lib/credits/deductionGroups';

// The web Jest config matches `*.test.ts` only, so this renders the shipped
// component through `createElement` rather than JSX.
function render(groups: DeductionGroup[]): string {
  return renderToStaticMarkup(createElement(CreditsDeductionRows, { groups }));
}

const pairedGroup: DeductionGroup = {
  key: 'expiry-1',
  main: {
    date: '2025-03-03T00:00:00.000Z',
    description: 'Promotional credits',
    type: 'Credit grant',
    amount_mUsd: 50_000_000,
  },
  child: {
    description: 'Expired: Promotional credits',
    type: 'Adjustment',
    amount_mUsd: -50_000_000,
  },
};

describe('CreditsDeductionRows', () => {
  function cellClasses(rowHtml: string): string[] {
    return Array.from(rowHtml.matchAll(/<td[^>]*class="([^"]*)"/g), match => match[1]);
  }

  it('renders the grant as the main row and the expiry beneath it', () => {
    const rows = render([pairedGroup]).split('</tr>');

    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Promotional credits');
    expect(rows[0]).toContain('Credit grant');
    expect(rows[0]).toContain('+$50.00');
    expect(rows[1]).toContain('└');
    expect(rows[1]).toContain('Expired: Promotional credits');
    expect(rows[1]).toContain('Adjustment');
    expect(rows[1]).toContain('-$50.00');
    // Only the group start draws a divider between groups.
    expect(rows[0]).toContain('border-t');
    expect(rows[1]).not.toContain('border-t');
  });

  it('aligns the date and amount figures and lets the description wrap', () => {
    const rows = render([pairedGroup]).split('</tr>');
    const main = cellClasses(rows[0]);
    const child = cellClasses(rows[1]);

    // Date and amount are tabular; the description wraps instead of clipping.
    expect(main[0]).toContain('tabular-nums');
    expect(main[3]).toContain('tabular-nums');
    expect(main[3]).toContain('text-right');
    expect(main[1]).toContain('whitespace-normal');
    expect(main[1]).not.toContain('whitespace-nowrap');
    expect(child[1]).toContain('whitespace-normal');
    expect(child[1]).not.toContain('whitespace-nowrap');
  });

  it('renders an unlinked deduction as a single row with its own type and amount', () => {
    const html = render([
      {
        key: 'usage-1',
        main: {
          date: '2025-03-04T00:00:00.000Z',
          description: 'Usage charge',
          type: 'Deduction',
          amount_mUsd: -3_000_000,
        },
      },
    ]);

    expect(html.split('</tr>')).toHaveLength(2);
    expect(html).toContain('Usage charge');
    expect(html).toContain('Deduction');
    expect(html).toContain('-$3.00');
    expect(html).not.toContain('└');
  });
});
