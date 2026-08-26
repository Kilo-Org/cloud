import { buildSalesDemoUsagePlan } from './sales-demo-usage';

function memberIds(): string[] {
  const demoIds = Array.from(
    { length: 25 },
    (_, i) => `sales-demo-member-${String(i + 1).padStart(2, '0')}`
  );
  return [...demoIds, 'owner-user-id'];
}

describe('sales demo usage plan', () => {
  it('is deterministic for the same org id and UTC date string', () => {
    const organizationId = '00000000-0000-4000-8000-000000000000';
    const ids = memberIds();

    const morning = new Date('2026-08-25T01:00:00Z');
    const evening = new Date('2026-08-25T23:00:00Z');

    const plan1 = buildSalesDemoUsagePlan(organizationId, ids, morning);
    const plan2 = buildSalesDemoUsagePlan(organizationId, ids, evening);

    expect(plan1.seededMicrodollars).toBe(plan2.seededMicrodollars);
    expect(plan1.perUserDayTotals).toEqual(plan2.perUserDayTotals);
  });

  it('sums seeded microdollars to the per-user-day totals', () => {
    const plan = buildSalesDemoUsagePlan(
      '00000000-0000-4000-8000-000000000000',
      memberIds(),
      new Date('2026-08-25T12:00:00Z')
    );

    const totalFromUserDays = plan.perUserDayTotals.reduce((acc, entry) => acc + entry.total, 0);
    expect(plan.seededMicrodollars).toBe(totalFromUserDays);
    expect(plan.seededMicrodollars).toBeGreaterThan(0);
  });

  it('keeps today usage for members 01-03 inside 80-95% of the daily limit', () => {
    const plan = buildSalesDemoUsagePlan(
      '00000000-0000-4000-8000-000000000000',
      memberIds(),
      new Date('2026-08-25T12:00:00Z')
    );

    const today = '2026-08-25';
    for (const memberId of [
      'sales-demo-member-01',
      'sales-demo-member-02',
      'sales-demo-member-03',
    ]) {
      const todayEntries = plan.perUserDayTotals.filter(
        entry => entry.kiloUserId === memberId && entry.usageDate === today
      );
      const todayTotal = todayEntries.reduce((acc, entry) => acc + entry.total, 0);
      expect(todayTotal).toBeGreaterThanOrEqual(20_000_000);
      expect(todayTotal).toBeLessThanOrEqual(23_750_000);
    }
  });
});
