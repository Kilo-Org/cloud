import { describe, test, expect } from '@jest/globals';
import { insertTestUser } from '../tests/helpers/user.helper';
import { createTestOrganization } from '../tests/helpers/organization.helper';

import {
  getCreditTransactionsForOrganization,
  getCreditTransactionsForOrganizationPage,
} from '@/lib/creditTransactions';
import { db, pool } from './drizzle';
import { credit_transactions } from '@kilocode/db/schema';

function whereClause(text: string): string {
  const match = text.match(/\bwhere\s+(.+?)\s+order by\s/);
  return match ? match[1] : '';
}

describe('getCreditTransactionsForOrganizationPage', () => {
  test('pages 26 transactions into 25 entries and matches the summary for the excluded set', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('page org', user.id, 0);

    const purchases = Array.from({ length: 26 }, () => ({
      kilo_user_id: user.id,
      organization_id: org.id,
      is_free: false,
      amount_microdollars: 1_000_000,
      description: 'purchase',
    }));
    await db.insert(credit_transactions).values(purchases);

    // kpo:consumption rows must be absent from both the page and the summary.
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: user.id,
        organization_id: org.id,
        is_free: true,
        amount_microdollars: 5_000_000,
        credit_category: 'kpo:consumption:models',
        description: 'consumption',
      },
      {
        kilo_user_id: user.id,
        organization_id: org.id,
        is_free: true,
        amount_microdollars: 5_000_000,
        credit_category: 'kpo:consumption:models',
        description: 'consumption',
      },
    ]);

    const page = await getCreditTransactionsForOrganizationPage(org.id);

    expect(page.entries).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(25);
    expect(page.entries.every(entry => !entry.credit_category?.startsWith('kpo:consumption'))).toBe(
      true
    );

    expect(page.summary).toEqual({
      total_promotional_musd: 0,
      total_purchased_musd: 26_000_000,
      credit_transaction_count: 26,
    });
  });

  test('returns empty entries, hasMore false, and zero summary for an empty organization', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('empty page org', user.id, 0);

    const page = await getCreditTransactionsForOrganizationPage(org.id);

    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.summary).toEqual({
      total_promotional_musd: 0,
      total_purchased_musd: 0,
      credit_transaction_count: 0,
    });
  });

  test('page SQL keeps the old where clause and adds id ordering plus limit+1', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('sql page org', user.id, 0);

    const querySpy = jest.spyOn(pool, 'query');

    await getCreditTransactionsForOrganization(org.id);
    await getCreditTransactionsForOrganizationPage(org.id);

    const captured = (querySpy.mock.calls as unknown as unknown[][]).map(call => {
      const first = call[0];
      const text =
        typeof first === 'string' ? first : ((first as { text?: string } | null)?.text ?? '');
      return { text, params: (call[1] ?? []) as unknown[] };
    });

    const oldQuery = captured.find(call => call.text.includes('from "credit_transactions"'));
    const pageQuery = captured.find(call => call.text.includes('"id" desc'));

    expect(oldQuery).toBeDefined();
    expect(pageQuery).toBeDefined();

    expect(whereClause(pageQuery!.text)).toBe(whereClause(oldQuery!.text));

    expect(pageQuery!.text).toContain('"created_at" desc');
    expect(pageQuery!.text.indexOf('"created_at" desc')).toBeLessThan(
      pageQuery!.text.indexOf('"id" desc')
    );
    expect(oldQuery!.text).not.toContain('"id" desc');

    expect(pageQuery!.params).toContain(26);

    querySpy.mockRestore();
  });
});
