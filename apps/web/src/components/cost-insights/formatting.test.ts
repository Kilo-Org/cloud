import {
  formatCostInsightDateTime,
  formatCostInsightElapsedWindow,
  formatCostInsightHourWindow,
  formatSpendEvidenceTime,
  niceCeil,
  spendBarHeightPercent,
  spendRangePeriodLabel,
} from './formatting';

describe('Cost Insights formatting', () => {
  it('keeps zero-spend chart buckets at zero height', () => {
    expect(spendBarHeightPercent(0, 100)).toBe(0);
  });

  it('keeps a visible minimum for nonzero chart buckets', () => {
    expect(spendBarHeightPercent(0.1, 100)).toBe(2);
  });

  it('rounds spend axis maxima up to readable 1/2/5 bounds', () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(160.96)).toBe(200);
    expect(niceCeil(127.08)).toBe(200);
    expect(niceCeil(95)).toBe(100);
    expect(niceCeil(1.65)).toBe(2);
    expect(niceCeil(0.57)).toBe(1);
  });

  it('labels every selectable spend period', () => {
    expect([
      spendRangePeriodLabel('1h'),
      spendRangePeriodLabel('24h'),
      spendRangePeriodLabel('7d'),
      spendRangePeriodLabel('30d'),
      spendRangePeriodLabel('90d'),
    ]).toEqual([
      'the current hour',
      'the last 24 hours',
      'the last 7 days',
      'the last 30 days',
      'the last 90 days',
    ]);
  });

  it('formats timestamps in local 24-hour time without a suffix', () => {
    const label = formatCostInsightDateTime('2026-06-26T08:00:00.000Z', 'America/New_York');

    expect(label).toBe('Jun 26, 04:00');
    expect(label).not.toContain('AM');
    expect(label).not.toContain('PM');
    expect(label).not.toContain('EDT');
    expect(label).not.toContain('UTC');
  });

  it('formats evidence labels in the requested time zone', () => {
    expect(formatSpendEvidenceTime('2026-06-26T08:00:00.000Z', '24h', 'America/New_York')).toBe(
      '04:00'
    );
    expect(formatSpendEvidenceTime('2026-06-26T08:00:00.000Z', '7d', 'America/New_York')).toBe(
      'Jun 26'
    );
    expect(formatSpendEvidenceTime('2026-06-26T00:00:00.000Z', '30d', 'America/Los_Angeles')).toBe(
      'Jun 25'
    );
    expect(formatSpendEvidenceTime('2026-06-25T18:00:00.000Z', '90d', 'Asia/Tokyo')).toBe('Jun 26');
  });

  it('formats elapsed windows with both local dates and times', () => {
    const label = formatCostInsightElapsedWindow(
      '2026-06-25T08:42:00.000Z',
      '2026-06-26T08:42:00.000Z',
      'America/New_York'
    );

    expect(label).toBe('Jun 25, 04:42-Jun 26, 04:42');
    expect(label).not.toContain('AM');
    expect(label).not.toContain('PM');
    expect(label).not.toContain('EDT');
    expect(label).not.toContain('UTC');
  });

  it('formats alert-hour windows in local 24-hour time without a suffix', () => {
    const label = formatCostInsightHourWindow(
      '2026-06-26T08:00:00.000Z',
      '2026-06-26T09:00:00.000Z',
      'America/New_York'
    );

    expect(label).toBe('Jun 26, 04:00-04:59');
    expect(label).not.toContain('AM');
    expect(label).not.toContain('PM');
    expect(label).not.toContain('EDT');
    expect(label).not.toContain('UTC');
  });
});
