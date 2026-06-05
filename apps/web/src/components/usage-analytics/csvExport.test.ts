jest.mock('@/lib/admin-csv', () => ({
  csvField: (value: string) => value,
  downloadCsv: jest.fn(),
}));

import { downloadCsv } from '@/lib/admin-csv';
import { exportUsageTableToCsv } from './csvExport';
import { metricLabelForCostSource, parseCostSource, type Dimension } from './types';

const rows = [
  {
    datetime: '2026-06-04',
    dimensions: {},
    costMicrodollars: 1_500_000,
    requestCount: 2,
    inputTokens: 3,
    outputTokens: 4,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    errorCount: 0,
  },
];

const labelForDimensionValue = (_dimension: Dimension, value: string) => value;

describe('usage analytics cost labels', () => {
  it('parses URL values with a billable cost fallback', () => {
    expect(parseCostSource('market')).toBe('market');
    expect(parseCostSource(null)).toBe('cost');
    expect(parseCostSource('invalid')).toBe('cost');
  });

  it('labels selected market cost metrics explicitly', () => {
    expect(metricLabelForCostSource('cost', 'market')).toBe('Estimated Market Cost');
    expect(metricLabelForCostSource('costPerRequest', 'market')).toBe(
      'Estimated Market Cost / Request'
    );
    expect(metricLabelForCostSource('tokens', 'market')).toBe('Tokens');
  });
});

describe('exportUsageTableToCsv', () => {
  beforeEach(() => {
    jest.mocked(downloadCsv).mockClear();
  });

  it('labels billable cost exports as cost', () => {
    exportUsageTableToCsv({
      rows,
      groupBy: [],
      granularity: 'day',
      period: 'today',
      costSource: 'cost',
      labelForDimensionValue,
    });

    expect(downloadCsv).toHaveBeenCalledWith(
      expect.stringContaining('Cost (USD)'),
      expect.any(String)
    );
  });

  it('labels market cost exports as estimated market cost', () => {
    exportUsageTableToCsv({
      rows,
      groupBy: [],
      granularity: 'day',
      period: 'today',
      costSource: 'market',
      labelForDimensionValue,
    });

    expect(downloadCsv).toHaveBeenCalledWith(
      expect.stringContaining('Estimated Market Cost (USD)'),
      expect.any(String)
    );
  });
});
