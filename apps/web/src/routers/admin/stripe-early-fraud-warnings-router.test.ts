import { beforeEach, describe, expect, it } from '@jest/globals';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { organizations, stripe_early_fraud_warning_cases, type User } from '@kilocode/db/schema';
import {
  StripeEarlyFraudWarningCaseStatus,
  StripeEarlyFraudWarningOwnerClassification,
} from '@kilocode/db/schema-types';

let admin: User;
let nonAdmin: User;
let personalOwner: User;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `admin-efw-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `non-admin-efw-${Math.random()}@example.com`,
  });
  personalOwner = await insertTestUser({
    google_user_email: `personal-efw-${Math.random()}@example.com`,
  });
});

describe('admin early fraud warnings list', () => {
  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.earlyFraudWarnings.list({ page: 1, limit: 25 })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns read-only personal and organization warning rows with normalized timestamps', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Manual Review Org', stripe_customer_id: 'cus_review_org' })
      .returning();
    await db.insert(stripe_early_fraud_warning_cases).values([
      {
        stripe_early_fraud_warning_id: 'issfr_personal_list',
        stripe_event_id: 'evt_personal_list',
        stripe_charge_id: 'ch_personal_list',
        stripe_payment_intent_id: 'pi_personal_list',
        stripe_customer_id: personalOwner.stripe_customer_id,
        amount_minor_units: 2900,
        currency: 'usd',
        owner_classification: StripeEarlyFraudWarningOwnerClassification.Personal,
        kilo_user_id: personalOwner.id,
        status: StripeEarlyFraudWarningCaseStatus.ReviewRequired,
        reason: 'Observation only: canonical personal owner matched; manual review required',
        warning_created_at: '2026-05-27 10:11:12.123+00',
        review_required_at: '2026-05-27 10:11:13.123+00',
      },
      {
        stripe_early_fraud_warning_id: 'issfr_organization_list',
        stripe_event_id: 'evt_organization_list',
        stripe_charge_id: 'ch_organization_list',
        stripe_customer_id: 'cus_review_org',
        amount_minor_units: 4500,
        currency: 'eur',
        owner_classification: StripeEarlyFraudWarningOwnerClassification.Organization,
        organization_id: organization.id,
        status: StripeEarlyFraudWarningCaseStatus.ReviewRequired,
        reason: 'Organization-owned warning; manual review required',
        warning_created_at: '2026-05-28 11:12:13.456+00',
        review_required_at: '2026-05-28 11:12:14.456+00',
      },
    ]);

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.earlyFraudWarnings.list({ page: 1, limit: 25 });

    expect(result.pagination).toEqual({ page: 1, limit: 25, total: 2, totalPages: 1 });
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        stripeEarlyFraudWarningId: 'issfr_organization_list',
        ownerClassification: 'organization',
        warningCreatedAt: '2026-05-28T11:12:13.456Z',
        organization: { id: organization.id, name: 'Manual Review Org' },
        user: null,
      })
    );
    expect(result.rows[1]).toEqual(
      expect.objectContaining({
        stripeEarlyFraudWarningId: 'issfr_personal_list',
        stripeChargeId: 'ch_personal_list',
        amountMinorUnits: 2900,
        ownerClassification: 'personal',
        warningCreatedAt: '2026-05-27T10:11:12.123Z',
        user: {
          id: personalOwner.id,
          email: personalOwner.google_user_email,
          name: personalOwner.google_user_name,
        },
        organization: null,
      })
    );
  });

  it('paginates dated warning cases before rows without warning timestamps', async () => {
    await db.insert(stripe_early_fraud_warning_cases).values([
      {
        stripe_early_fraud_warning_id: 'issfr_older',
        stripe_event_id: 'evt_older',
        owner_classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
        status: StripeEarlyFraudWarningCaseStatus.ReviewRequired,
        reason: 'No canonical customer owner matched; manual review required',
        warning_created_at: '2026-05-26T00:00:00.000Z',
      },
      {
        stripe_early_fraud_warning_id: 'issfr_newer',
        stripe_event_id: 'evt_newer',
        owner_classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
        status: StripeEarlyFraudWarningCaseStatus.ReviewRequired,
        reason: 'No canonical customer owner matched; manual review required',
        warning_created_at: '2026-05-27T00:00:00.000Z',
      },
      {
        stripe_early_fraud_warning_id: 'issfr_missing_warning_time',
        stripe_event_id: 'evt_missing_warning_time',
        owner_classification: StripeEarlyFraudWarningOwnerClassification.Unmatched,
        status: StripeEarlyFraudWarningCaseStatus.ReviewRequired,
        reason: 'Warning timestamp missing; manual review required',
        warning_created_at: null,
      },
    ]);

    const caller = await createCallerForUser(admin.id);
    const firstPage = await caller.admin.earlyFraudWarnings.list({ page: 1, limit: 1 });
    const secondPage = await caller.admin.earlyFraudWarnings.list({ page: 2, limit: 1 });
    const thirdPage = await caller.admin.earlyFraudWarnings.list({ page: 3, limit: 1 });

    expect(firstPage.pagination).toEqual({ page: 1, limit: 1, total: 3, totalPages: 3 });
    expect(firstPage.rows[0]?.stripeEarlyFraudWarningId).toBe('issfr_newer');
    expect(secondPage.rows[0]?.stripeEarlyFraudWarningId).toBe('issfr_older');
    expect(thirdPage.rows[0]?.stripeEarlyFraudWarningId).toBe('issfr_missing_warning_time');
    expect(thirdPage.rows[0]?.warningCreatedAt).toBeNull();
  });
});
