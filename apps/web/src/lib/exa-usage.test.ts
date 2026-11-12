import { describe, test, expect, afterEach } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  credit_transactions,
  exa_monthly_usage,
  exa_usage_log,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
  kilocode_users,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getExaMonthlyUsage, getExaFreeAllowanceMicrodollars, recordExaUsage } from './exa-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@kilocode/web-shared/lib/constants';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { activatePaidAgreement, createPendingAgreement } from './kilo-pass-org/service';
import type { ExaUsageRecord } from '@kilocode/usage-contracts';

function usageIdentity() {
  return { id: crypto.randomUUID(), occurredAt: new Date().toISOString() };
}

// Mock next/server's after function which requires request context
jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn((fn: () => Promise<void>) => {
    void fn();
  }),
}));

// Suppress Sentry in tests
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

describe('Exa Usage Tracking', () => {
  const passFixtureOrganizationIds: string[] = [];
  const passFixtureAgreementIds: string[] = [];

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(exa_monthly_usage);

    const organizationIds = passFixtureOrganizationIds.splice(0);
    const agreementIds = passFixtureAgreementIds.splice(0);
    if (organizationIds.length === 0) return;

    await db
      .delete(kilo_pass_org_qualifying_spend_events)
      .where(
        inArray(
          kilo_pass_org_qualifying_spend_events.allocation_container_organization_id,
          organizationIds
        )
      );
    await db
      .delete(kilo_pass_org_issuance_snapshots)
      .where(
        inArray(
          kilo_pass_org_issuance_snapshots.allocation_container_organization_id,
          organizationIds
        )
      );
    await db
      .delete(kilo_pass_org_audit_records)
      .where(inArray(kilo_pass_org_audit_records.agreement_id, agreementIds));
    await db
      .delete(kilo_pass_org_allocation_plan_rows)
      .where(
        inArray(
          kilo_pass_org_allocation_plan_rows.allocation_container_organization_id,
          organizationIds
        )
      );
    await db
      .delete(kilo_pass_org_agreements)
      .where(inArray(kilo_pass_org_agreements.parent_organization_id, organizationIds));
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.organization_id, organizationIds));
    await db.delete(exa_usage_log).where(inArray(exa_usage_log.organization_id, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  });

  describe('getExaFreeAllowanceMicrodollars', () => {
    test('returns the global constant for any user', async () => {
      const user = await insertTestUser();
      expect(getExaFreeAllowanceMicrodollars(new Date(), user)).toBe(
        EXA_MONTHLY_ALLOWANCE_MICRODOLLARS
      );
    });
  });

  describe('getExaMonthlyUsage', () => {
    test('returns zero usage and null freeAllowance when no row exists', async () => {
      const user = await insertTestUser();
      const result = await getExaMonthlyUsage(user.id);
      expect(result).toEqual({ usage: 0, freeAllowance: null });
    });

    test('returns usage and stored freeAllowance for the current month', async () => {
      const user = await insertTestUser();

      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 5_000_000,
        total_charged_microdollars: 0,
        request_count: 10,
        free_allowance_microdollars: 10_000_000,
      });

      const result = await getExaMonthlyUsage(user.id);
      expect(result).toEqual({ usage: 5_000_000, freeAllowance: 10_000_000 });
    });

    test('ignores usage from prior months', async () => {
      const user = await insertTestUser();

      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`(date_trunc('month', now()) - interval '1 month')::date`.mapWith(String),
        total_cost_microdollars: 9_000_000,
        total_charged_microdollars: 0,
        request_count: 50,
        free_allowance_microdollars: 10_000_000,
      });

      const result = await getExaMonthlyUsage(user.id);
      expect(result).toEqual({ usage: 0, freeAllowance: null });
    });
  });

  describe('recordExaUsage', () => {
    test('creates a counter row on first request with free allowance', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].total_cost_microdollars).toBe(7000);
      expect(rows[0].total_charged_microdollars).toBe(0);
      expect(rows[0].request_count).toBe(1);
      expect(rows[0].free_allowance_microdollars).toBe(10_000_000);
    });

    test('increments existing counter on subsequent requests', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/contents',
        costMicrodollars: 5000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].total_cost_microdollars).toBe(8000);
      expect(rows[0].request_count).toBe(2);
    });

    test('locks in free allowance from first request of the month', async () => {
      const user = await insertTestUser();

      // First request sets the allowance to 10M
      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 1000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      // Second request passes a different allowance (simulating a mid-month change)
      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 2000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 20_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      // Allowance should stay at the first-request value (10M), not the second (20M)
      expect(rows[0].free_allowance_microdollars).toBe(10_000_000);
      expect(rows[0].total_cost_microdollars).toBe(3000);
    });

    test('tracks charged amount separately when chargedToBalance is true', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 5000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows[0].total_cost_microdollars).toBe(8000);
      expect(rows[0].total_charged_microdollars).toBe(3000);
    });

    test('deducts from personal balance when chargedToBalance is true and no org', async () => {
      const user = await insertTestUser({
        microdollars_used: 0,
        total_microdollars_acquired: 100_000_000,
      });

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const [updated] = await db
        .select({ microdollars_used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));

      expect(updated.microdollars_used).toBe(7000);
    });

    test('charges organization and tracks member usage', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Exa usage organization', user.id, 50_000);

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: organization.id,
        path: '/contents',
        costMicrodollars: 9000,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const [chargedOrganization] = await db
        .select({ microdollars_used: organizations.microdollars_used })
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      expect(chargedOrganization.microdollars_used).toBe(9000);

      const [memberUsage] = await db
        .select()
        .from(organization_user_usage)
        .where(eq(organization_user_usage.organization_id, organization.id));
      expect(memberUsage).toMatchObject({
        kilo_user_id: user.id,
        microdollar_usage: 9000,
      });
    });

    test('rolls back charged Exa source and monthly rows when the user row is missing', async () => {
      const missingUserId = `missing-exa-user-${crypto.randomUUID()}`;

      await expect(
        recordExaUsage({
          ...usageIdentity(),
          userId: missingUserId,
          organizationId: null,
          path: '/search',
          costMicrodollars: 1000,
          chargedToBalance: true,
          freeAllowanceMicrodollars: 10_000_000,
        })
      ).rejects.toThrow('user disappeared during Exa consumption');

      const sourceRows = await db
        .select()
        .from(exa_usage_log)
        .where(eq(exa_usage_log.kilo_user_id, missingUserId));
      const monthlyRows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, missingUserId));
      expect(sourceRows).toHaveLength(0);
      expect(monthlyRows).toHaveLength(0);
    });

    test('does not deduct from balance when chargedToBalance is false', async () => {
      const user = await insertTestUser({ microdollars_used: 0 });

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const [updated] = await db
        .select({ microdollars_used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));

      expect(updated.microdollars_used).toBe(0);
    });

    test('creates separate counter rows for personal and org usage', async () => {
      const user = await insertTestUser();
      const orgId = crypto.randomUUID();

      // Personal request
      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      // Org request
      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: orgId,
        path: '/search',
        costMicrodollars: 5000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(2);

      const personalRow = rows.find(r => r.organization_id === null);
      const orgRow = rows.find(r => r.organization_id === orgId);
      expect(personalRow!.total_cost_microdollars).toBe(3000);
      expect(orgRow!.total_cost_microdollars).toBe(5000);
    });

    test('stores featureId and type in the usage log', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        ...usageIdentity(),
        userId: user.id,
        organizationId: null,
        path: '/search',
        costMicrodollars: 1000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
        featureId: 'kiloclaw',
        type: 'deep',
      });

      const [logRow] = await db
        .select()
        .from(exa_usage_log)
        .where(eq(exa_usage_log.kilo_user_id, user.id));

      expect(logRow.feature_id).toBe('kiloclaw');
      expect(logRow.type).toBe('deep');
    });

    test('getExaMonthlyUsage aggregates across personal and org rows', async () => {
      const user = await insertTestUser();
      const orgId = crypto.randomUUID();

      // Personal usage
      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 3_000_000,
        total_charged_microdollars: 0,
        request_count: 5,
        free_allowance_microdollars: 10_000_000,
      });

      // Org usage for the same user
      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        organization_id: orgId,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 5_000_000,
        total_charged_microdollars: 0,
        request_count: 10,
        free_allowance_microdollars: 10_000_000,
      });

      const result = await getExaMonthlyUsage(user.id);
      // Should sum both rows: 3M + 5M = 8M
      expect(result.usage).toBe(8_000_000);
      expect(result.freeAllowance).toBe(10_000_000);
    });

    describe('idempotency', () => {
      async function activePassFixture(occurredAt: Date) {
        const passWindow = {
          start: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), 1)),
          end: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 1, 1)),
        };
        const owner = await insertTestUser();
        const organization = await createTestOrganization(
          `exa-pass-${crypto.randomUUID()}`,
          owner.id,
          50_000
        );
        passFixtureOrganizationIds.push(organization.id);
        const agreement = await createPendingAgreement({
          parentOrganizationId: organization.id,
          actorUserId: owner.id,
          tier: 'tier_19',
          cadence: 'monthly',
          paidSeatCount: 1,
          issuanceAnchorAt: passWindow.start,
          providerSubscriptionId: `sub_${crypto.randomUUID()}`,
          providerSeatAddOnItemId: `si_${crypto.randomUUID()}`,
          initialAllocations: [],
        });
        passFixtureAgreementIds.push(agreement.agreementId);
        await activatePaidAgreement({
          agreementId: agreement.agreementId,
          recipientUserId: owner.id,
          paidFrom: passWindow.start,
          paidUntil: passWindow.end,
          paidSeatCount: 1,
          firstWindow: passWindow,
          isBridge: false,
        });
        return { owner, organization };
      }

      test('records a repeated personal charge once and reports duplicate', async () => {
        const user = await insertTestUser({
          microdollars_used: 0,
          total_microdollars_acquired: 100_000_000,
        });
        const input: ExaUsageRecord = {
          ...usageIdentity(),
          userId: user.id,
          organizationId: null,
          path: '/search',
          costMicrodollars: 7000,
          chargedToBalance: true,
          freeAllowanceMicrodollars: 10_000_000,
        };

        await expect(recordExaUsage(input)).resolves.toBe('recorded');
        await expect(recordExaUsage(input)).resolves.toBe('duplicate');

        const logRows = await db
          .select()
          .from(exa_usage_log)
          .where(eq(exa_usage_log.kilo_user_id, user.id));
        expect(logRows).toHaveLength(1);

        const monthlyRows = await db
          .select()
          .from(exa_monthly_usage)
          .where(eq(exa_monthly_usage.kilo_user_id, user.id));
        expect(monthlyRows).toHaveLength(1);
        expect(monthlyRows[0]).toMatchObject({
          total_cost_microdollars: 7000,
          total_charged_microdollars: 7000,
          request_count: 1,
        });

        const [updated] = await db
          .select({ microdollars_used: kilocode_users.microdollars_used })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, user.id));
        expect(updated.microdollars_used).toBe(7000);
      });

      test('records a repeated ordinary organization charge once and reports duplicate', async () => {
        const user = await insertTestUser();
        const organization = await createTestOrganization(
          `exa-org-${crypto.randomUUID()}`,
          user.id,
          50_000
        );
        const input: ExaUsageRecord = {
          ...usageIdentity(),
          userId: user.id,
          organizationId: organization.id,
          path: '/contents',
          costMicrodollars: 9000,
          chargedToBalance: true,
          freeAllowanceMicrodollars: 10_000_000,
        };

        await expect(recordExaUsage(input)).resolves.toBe('recorded');
        await expect(recordExaUsage(input)).resolves.toBe('duplicate');

        const logRows = await db
          .select()
          .from(exa_usage_log)
          .where(eq(exa_usage_log.kilo_user_id, user.id));
        expect(logRows).toHaveLength(1);

        const monthlyRows = await db
          .select()
          .from(exa_monthly_usage)
          .where(eq(exa_monthly_usage.kilo_user_id, user.id));
        expect(monthlyRows).toHaveLength(1);
        expect(monthlyRows[0]).toMatchObject({
          total_cost_microdollars: 9000,
          total_charged_microdollars: 9000,
          request_count: 1,
        });

        const [chargedOrganization] = await db
          .select({ microdollars_used: organizations.microdollars_used })
          .from(organizations)
          .where(eq(organizations.id, organization.id));
        expect(chargedOrganization.microdollars_used).toBe(9000);

        const [memberUsage] = await db
          .select()
          .from(organization_user_usage)
          .where(eq(organization_user_usage.organization_id, organization.id));
        expect(memberUsage).toMatchObject({
          kilo_user_id: user.id,
          microdollar_usage: 9000,
        });
      });

      test('records a repeated Kilo Pass organization charge once and reports duplicate', async () => {
        const occurredAt = new Date();
        const { owner, organization } = await activePassFixture(occurredAt);
        const input: ExaUsageRecord = {
          id: crypto.randomUUID(),
          occurredAt: occurredAt.toISOString(),
          userId: owner.id,
          organizationId: organization.id,
          path: '/contents',
          costMicrodollars: 9000,
          chargedToBalance: true,
          freeAllowanceMicrodollars: 10_000_000,
        };

        await expect(recordExaUsage(input)).resolves.toBe('recorded');
        await expect(recordExaUsage(input)).resolves.toBe('duplicate');

        const logRows = await db
          .select()
          .from(exa_usage_log)
          .where(eq(exa_usage_log.organization_id, organization.id));
        expect(logRows).toHaveLength(1);

        const monthlyRows = await db
          .select()
          .from(exa_monthly_usage)
          .where(eq(exa_monthly_usage.organization_id, organization.id));
        expect(monthlyRows).toHaveLength(1);
        expect(monthlyRows[0]).toMatchObject({
          total_cost_microdollars: 9000,
          total_charged_microdollars: 9000,
          request_count: 1,
        });

        const credits = await db
          .select()
          .from(credit_transactions)
          .where(eq(credit_transactions.organization_id, organization.id));
        const consumptionCredits = credits.filter(
          credit => credit.credit_category === `kpo:consumption:exa:${input.id}`
        );
        expect(consumptionCredits).toHaveLength(1);
        expect(consumptionCredits[0].amount_microdollars).toBe(-9000);

        const events = await db
          .select()
          .from(kilo_pass_org_qualifying_spend_events)
          .where(
            eq(
              kilo_pass_org_qualifying_spend_events.allocation_container_organization_id,
              organization.id
            )
          );
        expect(events).toHaveLength(1);
        expect(events[0].spent_microdollars).toBe(9000);

        const [chargedOrganization] = await db
          .select({ microdollars_used: organizations.microdollars_used })
          .from(organizations)
          .where(eq(organizations.id, organization.id));
        expect(chargedOrganization.microdollars_used).toBe(9000);
      });

      test('records concurrent duplicate submissions once', async () => {
        const user = await insertTestUser({
          microdollars_used: 0,
          total_microdollars_acquired: 100_000_000,
        });
        const input: ExaUsageRecord = {
          ...usageIdentity(),
          userId: user.id,
          organizationId: null,
          path: '/search',
          costMicrodollars: 7000,
          chargedToBalance: true,
          freeAllowanceMicrodollars: 10_000_000,
        };

        const results = await Promise.all([
          recordExaUsage(input),
          recordExaUsage(input),
          recordExaUsage(input),
        ]);
        expect(results.sort()).toEqual(['duplicate', 'duplicate', 'recorded']);

        const logRows = await db
          .select()
          .from(exa_usage_log)
          .where(eq(exa_usage_log.kilo_user_id, user.id));
        expect(logRows).toHaveLength(1);

        const monthlyRows = await db
          .select()
          .from(exa_monthly_usage)
          .where(eq(exa_monthly_usage.kilo_user_id, user.id));
        expect(monthlyRows).toHaveLength(1);
        expect(monthlyRows[0]).toMatchObject({
          total_cost_microdollars: 7000,
          total_charged_microdollars: 7000,
          request_count: 1,
        });

        const [updated] = await db
          .select({ microdollars_used: kilocode_users.microdollars_used })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, user.id));
        expect(updated.microdollars_used).toBe(7000);
      });

      test('records separate charges for different ids', async () => {
        const user = await insertTestUser();
        const base: Omit<ExaUsageRecord, 'id' | 'occurredAt'> = {
          userId: user.id,
          organizationId: null,
          path: '/search',
          costMicrodollars: 4000,
          chargedToBalance: false,
          freeAllowanceMicrodollars: 10_000_000,
        };

        await expect(recordExaUsage({ ...base, ...usageIdentity() })).resolves.toBe('recorded');
        await expect(recordExaUsage({ ...base, ...usageIdentity() })).resolves.toBe('recorded');

        const logRows = await db
          .select()
          .from(exa_usage_log)
          .where(eq(exa_usage_log.kilo_user_id, user.id));
        expect(logRows).toHaveLength(2);

        const monthlyRows = await db
          .select()
          .from(exa_monthly_usage)
          .where(eq(exa_monthly_usage.kilo_user_id, user.id));
        expect(monthlyRows).toHaveLength(1);
        expect(monthlyRows[0]).toMatchObject({
          total_cost_microdollars: 8000,
          request_count: 2,
        });
      });
    });
  });
});
