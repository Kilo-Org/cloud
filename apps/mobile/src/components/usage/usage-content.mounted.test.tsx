// Each tile of the totals grid is one accessibility element, announced in the
// order the tile reads (caption, value, then its own detail). Reading the grid
// by position instead puts both values first, both captions second, and the
// tokens tile's input/output detail after the average-cost caption.

import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { i18n } from '@/i18n';

import { UsageContent } from './usage-content';

const usage = vi.hoisted(() => ({
  summary: {
    costMicrodollars: 5_000_000,
    requestCount: 12,
    totalTokens: 2400,
    inputTokens: 2000,
    outputTokens: 400,
    costPerRequest: 2500,
  },
  points: [],
  models: [],
  features: [],
  summaryError: null,
  seriesError: null,
  breakdownError: null,
  isFetching: false,
  refetch: () => undefined,
}));

vi.mock('@/lib/hooks/use-usage-analytics', () => ({ useUsageAnalytics: () => usage }));
// The tiles are the subject, so money renders as a fixed shape and the compact
// token notation reads the same way the org section's test writes it.
vi.mock('@/components/usage/usage-format', () => ({
  formatUsageCost: (value: number) => `$${value / 1e6}`,
  formatUsageCostPrecise: (value: number) => `$${value / 1e6}`,
  humanizeDimension: (value: string) => value,
}));
vi.mock('@/lib/format', () => ({
  formatNumber: (value: number, _locale: string, options?: Intl.NumberFormatOptions) =>
    options?.notation === 'compact' ? `compact:${value}` : String(value),
  formatPrefixedMoney: (value: number) => `$${value}`,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/usage/usage-bar-chart', () => ({ UsageBarChart: 'UsageBarChart' }));
vi.mock('@/components/usage/usage-breakdown-list', () => ({
  UsageBreakdownList: 'UsageBreakdownList',
}));
vi.mock('react-native', () => ({ View: 'View' }));

const DETAIL = i18n.t('codeReviewer.reviewDetail.tokensInOut', {
  input: 'compact:2000',
  output: 'compact:400',
});

describe('Usage totals grid accessibility', () => {
  it('speaks each tile once, caption then value then its own detail', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(UsageContent, { scope: { kind: 'personal' } })
    );

    // `Card` spreads onto a `View`, so a tile that is its own element is the
    // accessible `View`; render order is grid order (row-major).
    const tiles = renderer.root
      .findAllByType('View')
      .filter(node => node.props.accessible === true);
    const labels = tiles.map(tile => tile.props.accessibilityLabel);

    expect(tiles).toHaveLength(4);
    expect(labels).toEqual([
      'Cost, \u2066$5\u2069',
      'Requests, 12',
      `Tokens, compact:2400, ${DETAIL}`,
      'Avg cost / req, \u2066$0.0025\u2069',
    ]);
    // The input/output detail belongs to the tokens tile, never to the average
    // cost tile that follows it on the second row.
    expect(labels[2]).toContain(DETAIL);
    expect(labels[3]).not.toContain(DETAIL);
    unmount();
  });

  it('leaves no painted line of a tile in either accessibility tree', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(UsageContent, { scope: { kind: 'personal' } })
    );

    const tiles = renderer.root
      .findAllByType('View')
      .filter(node => node.props.accessible === true);
    // The tokens tile paints three lines: value, caption and the detail.
    expect(tiles[2]?.findAllByType('Text')).toHaveLength(3);
    for (const tile of tiles) {
      const lines = tile.findAllByType('Text');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.props.accessible).toBe(false);
        expect(line.props.importantForAccessibility).toBe('no');
      }
    }
    unmount();
  });
});
