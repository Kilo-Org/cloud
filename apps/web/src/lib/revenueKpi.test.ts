import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  credit_transactions,
  organization_service_fee_exemptions,
  stripe_service_fee_assessments,
} from '@kilocode/db/schema';
import { format } from 'date-fns';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { getRevenueKpiData, type RevenueKpiData } from '@/lib/revenueKpi';
import { SERVICE_FEE_VERSION } from '@/lib/service-fees/constants';
import { insertTestUser } from '@/tests/helpers/user.helper';

beforeEach(async () => {
  await cleanupDbForTest();
});

function dayKey(row: RevenueKpiData): string {
  const value = row.transaction_day as unknown;
  return value instanceof Date ? format(value, 'yyyy-MM-dd') : String(value).slice(0, 10);
}

function baseAssessment(
  overrides: Partial<typeof stripe_service_fee_assessments.$inferInsert>
): typeof stripe_service_fee_assessments.$inferInsert {
  return {
    assessment_key: `test-${crypto.randomUUID()}`,
    version: SERVICE_FEE_VERSION,
    flow: 'personal_top_up',
    outcome: 'charged',
    currency: 'usd',
    eligibility_created_at: '2025-01-10T09:00:00.000Z',
    eligible_subtotal_minor: 10000,
    expected_fee_minor: 500,
    ...overrides,
  };
}

describe('getRevenueKpiData service fee reporting', () => {
  test('keeps credit revenue semantics and reports settled fee metrics separately', async () => {
    const user = await insertTestUser();
    const admin = await insertTestUser();
    const organization = await createOrganization(`Org ${crypto.randomUUID()}`, admin.id);
    const [exemption] = await db
      .insert(organization_service_fee_exemptions)
      .values({
        organization_id: organization.id,
        is_exempt: true,
        reason: 'Founding partner exemption',
      })
      .returning();

    await db.insert(stripe_service_fee_assessments).values([
      baseAssessment({
        kilo_user_id: user.id,
        stripe_charge_id: 'ch_matched',
        charged_fee_minor: 500,
        gross_paid_minor: 10500,
        settled_product_minor: 10000,
        settled_at: '2025-01-10T10:00:00.000Z',
      }),
      // Refund plus full-charge dispute overlap. Collected fee clamps at zero
      // per assessment rather than allowing this row to subtract from another.
      baseAssessment({
        kilo_user_id: user.id,
        eligible_subtotal_minor: 20000,
        expected_fee_minor: 1000,
        charged_fee_minor: 1000,
        gross_paid_minor: 21000,
        settled_product_minor: 20000,
        refunded_product_minor: 4000,
        refunded_fee_minor: 200,
        disputed_fee_minor: 1000,
        settled_at: '2025-01-11T04:30:00.000Z',
      }),
      baseAssessment({
        kilo_user_id: user.id,
        eligible_subtotal_minor: 5000,
        expected_fee_minor: 250,
        charged_fee_minor: 250,
        gross_paid_minor: 5250,
        settled_product_minor: 5000,
        settled_at: '2025-01-11T06:00:00.000Z',
      }),
      baseAssessment({
        kilo_user_id: user.id,
        outcome: 'missed',
        failure_code: 'stripe_fee_line_attach_failed',
        settled_product_minor: 10000,
        gross_paid_minor: 10000,
        settled_at: '2025-01-12T00:30:00.000Z',
      }),
      baseAssessment({
        flow: 'organization_top_up',
        kilo_user_id: null,
        organization_id: organization.id,
        outcome: 'exempt',
        exemption_id: exemption.id,
        eligible_subtotal_minor: 5000,
        expected_fee_minor: 250,
        settled_product_minor: 5000,
        gross_paid_minor: 5000,
        settled_at: '2025-01-12T01:00:00.000Z',
      }),
      baseAssessment({
        kilo_user_id: user.id,
        eligibility_created_at: '2025-01-13T09:00:00.000Z',
        stripe_invoice_fee_line_item_id: 'il_unsettled_fee_line',
        charged_fee_minor: 9999,
      }),
    ]);

    await db.insert(credit_transactions).values([
      // Assessment-backed credits remain in every legacy credit series.
      {
        kilo_user_id: user.id,
        amount_microdollars: 100_000_000,
        is_free: false,
        stripe_payment_id: 'ch_matched',
        created_at: '2025-01-10T10:05:00.000Z',
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: 50_000_000,
        is_free: false,
        stripe_payment_id: 'ch_legacy_only',
        created_at: '2025-01-10T12:00:00.000Z',
      },
    ]);

    const { data } = await getRevenueKpiData(false, '2025-01-09', '2025-01-13');
    const byDay = new Map(data.map(row => [dayKey(row), row]));

    expect([...byDay.keys()]).toEqual(['2025-01-10', '2025-01-11', '2025-01-12']);
    expect(byDay.get('2025-01-10')).toMatchObject({
      paid_transaction_count: 2,
      paid_total_dollars: 150,
      collected_service_fee_dollars: 5,
      service_fee_charged_count: 1,
    });
    expect(byDay.get('2025-01-11')).toMatchObject({
      paid_transaction_count: 0,
      collected_service_fee_dollars: 2.5,
      disputed_service_fee_dollars: 10,
      service_fee_charged_count: 2,
    });
    expect(byDay.get('2025-01-12')).toMatchObject({
      collected_service_fee_dollars: 0,
      missed_service_fee_dollars: 5,
      exempted_service_fee_dollars: 2.5,
      service_fee_charged_count: 0,
      service_fee_missed_count: 1,
      service_fee_exempt_count: 1,
    });
  });

  test('creates a fee-only UTC day without inventing product revenue', async () => {
    const user = await insertTestUser();

    await db.insert(stripe_service_fee_assessments).values(
      baseAssessment({
        flow: 'personal_kilo_pass',
        kilo_user_id: user.id,
        charged_fee_minor: 245,
        gross_paid_minor: 5145,
        settled_product_minor: 4900,
        settled_at: '2025-03-01T04:30:00.000Z',
      })
    );

    const { data } = await getRevenueKpiData(false, '2025-03-01', '2025-03-01');

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      paid_transaction_count: 0,
      paid_total_dollars: 0,
      collected_service_fee_dollars: 2.45,
      service_fee_charged_count: 1,
    });
  });

  test('returns zero-valued service fee fields for legacy-only ranges', async () => {
    const user = await insertTestUser();

    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 25_000_000,
      is_free: false,
      stripe_payment_id: 'ch_legacy_only',
      created_at: '2025-02-01T12:00:00.000Z',
    });

    const { data } = await getRevenueKpiData(false, '2025-02-01', '2025-02-01');

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      paid_total_dollars: 25,
      collected_service_fee_dollars: 0,
      missed_service_fee_dollars: 0,
      exempted_service_fee_dollars: 0,
      disputed_service_fee_dollars: 0,
      service_fee_charged_count: 0,
      service_fee_missed_count: 0,
      service_fee_exempt_count: 0,
    });
  });
});
