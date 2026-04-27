import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertUsageWithOverrides } from '@/tests/helpers/microdollar-usage.helper';
import { processDay, processMonth } from '@/lib/usage-analytics/rollup';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { db, pool } from '@/lib/drizzle';
import {
  microdollar_usage,
  usage_rollup_daily,
  usage_rollup_daily_totals,
  usage_rollup_hourly,
  usage_rollup_hourly_totals,
  usage_rollup_monthly,
  usage_rollup_monthly_totals,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';

let orgOwner: User;
let orgMember: User;
let personalUser: User;
let testOrg: Organization;

async function getTodayIsoDate(): Promise<string> {
  const { rows } = await pool.query<{ d: string }>(
    "SELECT (date_trunc('day', now()))::date::text AS d"
  );
  return rows[0].d;
}

async function dateAt(hoursAgo: number): Promise<string> {
  const { rows } = await pool.query<{ t: string }>(
    `SELECT (now() - interval '${hoursAgo} hours')::text AS t`
  );
  return rows[0].t;
}

describe('usageAnalytics router', () => {
  beforeAll(async () => {
    orgOwner = await insertTestUser({
      google_user_email: 'usage-analytics-owner@example.com',
      google_user_name: 'Owner',
      is_admin: false,
    });
    orgMember = await insertTestUser({
      google_user_email: 'usage-analytics-member@example.com',
      google_user_name: 'Member',
      is_admin: false,
    });
    personalUser = await insertTestUser({
      google_user_email: 'usage-analytics-personal@example.com',
      google_user_name: 'Personal',
      is_admin: false,
    });
    testOrg = await createOrganization('UsageAnalytics Test Org', orgOwner.id);
    await addUserToOrganization(testOrg.id, orgMember.id, 'member');
  });

  afterEach(async () => {
    await db.delete(microdollar_usage).where(eq(microdollar_usage.organization_id, testOrg.id));
    await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, personalUser.id));
    await db.delete(usage_rollup_hourly).where(eq(usage_rollup_hourly.organization_id, testOrg.id));
    await db
      .delete(usage_rollup_hourly_totals)
      .where(eq(usage_rollup_hourly_totals.organization_id, testOrg.id));
    await db.delete(usage_rollup_daily).where(eq(usage_rollup_daily.organization_id, testOrg.id));
    await db
      .delete(usage_rollup_daily_totals)
      .where(eq(usage_rollup_daily_totals.organization_id, testOrg.id));
    await db
      .delete(usage_rollup_monthly)
      .where(eq(usage_rollup_monthly.organization_id, testOrg.id));
    await db
      .delete(usage_rollup_monthly_totals)
      .where(eq(usage_rollup_monthly_totals.organization_id, testOrg.id));
    await db
      .delete(usage_rollup_hourly)
      .where(eq(usage_rollup_hourly.kilo_user_id, personalUser.id));
    await db
      .delete(usage_rollup_hourly_totals)
      .where(eq(usage_rollup_hourly_totals.kilo_user_id, personalUser.id));
    await db.delete(usage_rollup_daily).where(eq(usage_rollup_daily.kilo_user_id, personalUser.id));
    await db
      .delete(usage_rollup_daily_totals)
      .where(eq(usage_rollup_daily_totals.kilo_user_id, personalUser.id));
    await db
      .delete(usage_rollup_monthly)
      .where(eq(usage_rollup_monthly.kilo_user_id, personalUser.id));
    await db
      .delete(usage_rollup_monthly_totals)
      .where(eq(usage_rollup_monthly_totals.kilo_user_id, personalUser.id));
  });

  describe('rollup pipeline', () => {
    it('produces summary values matching inserted usage for an org', async () => {
      const today = await getTodayIsoDate();
      const twoHoursAgo = await dateAt(2);
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 1500,
        input_tokens: 300,
        output_tokens: 200,
        cache_write_tokens: 10,
        cache_hit_tokens: 90,
        created_at: twoHoursAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 500,
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 0,
        cache_hit_tokens: 10,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      const counts = await processDay(today);
      expect(counts.dailyTotals).toBe(1);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      const summary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
      });

      expect(summary.costMicrodollars).toBe(2000);
      expect(summary.requestCount).toBe(2);
      expect(summary.inputTokens).toBe(400);
      expect(summary.outputTokens).toBe(250);
      expect(summary.cacheHitTokens).toBe(100);
    });

    it('supports dimension filters via wide table', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 1000,
        input_tokens: 100,
        output_tokens: 50,
        created_at: oneHourAgo,
        model: 'gpt-4',
        requested_model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 2000,
        input_tokens: 200,
        output_tokens: 100,
        created_at: oneHourAgo,
        model: 'claude-3-opus',
        requested_model: 'claude-3-opus',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const totalSummary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
      });
      expect(totalSummary.costMicrodollars).toBe(3000);

      const filteredSummary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
        models: ['gpt-4'],
      });
      expect(filteredSummary.costMicrodollars).toBe(1000);
    });

    it('produces breakdown ordered by metric value', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 1000,
        input_tokens: 100,
        output_tokens: 50,
        created_at: oneHourAgo,
        model: 'gpt-4',
        requested_model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 4000,
        input_tokens: 400,
        output_tokens: 100,
        created_at: oneHourAgo,
        model: 'claude-3-opus',
        requested_model: 'claude-3-opus',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const breakdown = await caller.usageAnalytics.getBreakdown({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
        dimension: 'model',
        metric: 'cost',
      });

      expect(breakdown.breakdown).toHaveLength(2);
      expect(breakdown.breakdown[0].key).toBe('claude-3-opus');
      expect(breakdown.breakdown[0].value).toBe(4000);
      expect(breakdown.breakdown[1].key).toBe('gpt-4');
      expect(breakdown.breakdown[1].value).toBe(1000);
      expect(breakdown.totalValue).toBe(5000);
    });

    it('reprocessing a day is idempotent', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 1000,
        input_tokens: 50,
        output_tokens: 25,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);
      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const summary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
      });
      expect(summary.costMicrodollars).toBe(1000);
      expect(summary.requestCount).toBe(1);
    });

    it('restricts personal scope to the authenticated user', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: personalUser.id,
        organization_id: null,
        cost: 500,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id, // different user
        organization_id: null,
        cost: 9999,
        input_tokens: 100,
        output_tokens: 100,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);

      const caller = await createCallerForUser(personalUser.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const summary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
      });
      expect(summary.costMicrodollars).toBe(500);
    });

    it('derives aggregate metrics (errorRate, cacheHitRatio) from rolled-up counts', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 100,
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 0,
        cache_hit_tokens: 100,
        has_error: false,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 100,
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        has_error: true,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const summary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
      });
      expect(summary.errorCount).toBe(1);
      expect(summary.requestCount).toBe(2);
      expect(summary.errorRate).toBe(0.5);
      // cacheHit / (input + cacheHit) = 100 / 300
      expect(summary.cacheHitRatio).toBeCloseTo(100 / 300, 5);
    });

    it('computes monthly rollup when processMonth runs', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);
      const monthIso = `${today.slice(0, 7)}-01`;

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 1234,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);
      await processMonth(monthIso);

      const monthRows = await db
        .select()
        .from(usage_rollup_monthly_totals)
        .where(eq(usage_rollup_monthly_totals.organization_id, testOrg.id));

      expect(monthRows).toHaveLength(1);
      expect(monthRows[0].cost_microdollars).toBe(1234);
    });

    it('applies exclude filters server-side', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 1000,
        input_tokens: 100,
        output_tokens: 50,
        created_at: oneHourAgo,
        model: 'gpt-4',
        requested_model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 5000,
        input_tokens: 500,
        output_tokens: 250,
        created_at: oneHourAgo,
        model: 'claude-3-opus',
        requested_model: 'claude-3-opus',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const excludingClaude = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
        excludedModels: ['claude-3-opus'],
      });
      expect(excludingClaude.costMicrodollars).toBe(1000);
    });

    it('personalScope=personal-only hides org usage for the current user', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgOwner.id,
        organization_id: null,
        cost: 250,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgOwner.id,
        organization_id: testOrg.id,
        cost: 999_999,
        input_tokens: 100,
        output_tokens: 100,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgOwner.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const personalOnly = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        personalScope: 'personal-only',
      });
      expect(personalOnly.costMicrodollars).toBe(250);

      const includeOrgs = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        personalScope: 'include-orgs',
      });
      expect(includeOrgs.costMicrodollars).toBe(250 + 999_999);
    });

    it('reports distinct active users in the summary for an org', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgOwner.id,
        organization_id: testOrg.id,
        cost: 100,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 200,
        input_tokens: 20,
        output_tokens: 10,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 300,
        input_tokens: 30,
        output_tokens: 15,
        created_at: oneHourAgo,
        model: 'claude-3-opus',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgOwner.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      // Owner must opt into org-wide view to see all users (default is self).
      const summary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
        viewAs: 'org-wide',
      });

      expect(summary.distinctUsers).toBe(2);
      expect(summary.requestCount).toBe(3);
    });

    it('resolveOrgUsers does not leak users outside the organization', async () => {
      // Create another user not in testOrg
      const outsideUser = await insertTestUser({
        google_user_email: 'outside-user-usage@example.com',
        google_user_name: 'Outside User',
        is_admin: false,
      });

      // Owner calling: may resolve all members (but not users outside the org).
      const caller = await createCallerForUser(orgOwner.id);
      const result = await caller.usageAnalytics.resolveOrgUsers({
        organizationId: testOrg.id,
        userIds: [orgOwner.id, orgMember.id, outsideUser.id, 'non-existent-id'],
      });

      const returnedIds = result.users.map(u => u.id).sort();
      expect(returnedIds).toEqual([orgMember.id, orgOwner.id].sort());
      expect(returnedIds).not.toContain(outsideUser.id);
    });

    it('resolveOrgUsers restricts members to resolving only themselves', async () => {
      const caller = await createCallerForUser(orgMember.id);
      const result = await caller.usageAnalytics.resolveOrgUsers({
        organizationId: testOrg.id,
        userIds: [orgOwner.id, orgMember.id],
      });

      // Member should only see their own entry — no enumeration of teammates.
      const returnedIds = result.users.map(u => u.id);
      expect(returnedIds).toEqual([orgMember.id]);
    });
  });

  describe('view-as role gating', () => {
    async function seedOwnerAndMemberUsage() {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgOwner.id,
        organization_id: testOrg.id,
        cost: 700,
        input_tokens: 100,
        output_tokens: 50,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 300,
        input_tokens: 50,
        output_tokens: 25,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);
    }

    function past24hRange() {
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      return {
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour' as const,
      };
    }

    it('defaults viewAs to self when omitted for org scope (members see only themselves)', async () => {
      await seedOwnerAndMemberUsage();

      const caller = await createCallerForUser(orgMember.id);
      const summary = await caller.usageAnalytics.getSummary({
        ...past24hRange(),
        organizationId: testOrg.id,
      });

      // Implicit self-scope: member only sees their 300, not the owner's 700.
      expect(summary.costMicrodollars).toBe(300);
      expect(summary.requestCount).toBe(1);
    });

    it('rejects viewAs=org-wide for a plain member', async () => {
      await seedOwnerAndMemberUsage();

      const caller = await createCallerForUser(orgMember.id);
      await expect(
        caller.usageAnalytics.getSummary({
          ...past24hRange(),
          organizationId: testOrg.id,
          viewAs: 'org-wide',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('allows viewAs=org-wide for an owner and returns all users', async () => {
      await seedOwnerAndMemberUsage();

      const caller = await createCallerForUser(orgOwner.id);
      const summary = await caller.usageAnalytics.getSummary({
        ...past24hRange(),
        organizationId: testOrg.id,
        viewAs: 'org-wide',
      });

      expect(summary.costMicrodollars).toBe(1000);
      expect(summary.requestCount).toBe(2);
      expect(summary.distinctUsers).toBe(2);
    });

    it('allows viewAs=org-wide for a billing_manager', async () => {
      await seedOwnerAndMemberUsage();

      const billingManager = await insertTestUser({
        google_user_email: 'usage-analytics-billing@example.com',
        google_user_name: 'Billing',
        is_admin: false,
      });
      await addUserToOrganization(testOrg.id, billingManager.id, 'billing_manager');

      const caller = await createCallerForUser(billingManager.id);
      const summary = await caller.usageAnalytics.getSummary({
        ...past24hRange(),
        organizationId: testOrg.id,
        viewAs: 'org-wide',
      });

      expect(summary.costMicrodollars).toBe(1000);
      expect(summary.distinctUsers).toBe(2);
    });

    it('rejects a member passing userIds for another user in self scope', async () => {
      await seedOwnerAndMemberUsage();

      const caller = await createCallerForUser(orgMember.id);
      await expect(
        caller.usageAnalytics.getSummary({
          ...past24hRange(),
          organizationId: testOrg.id,
          userIds: [orgOwner.id],
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('owner with viewAs=self sees only their own usage', async () => {
      await seedOwnerAndMemberUsage();

      const caller = await createCallerForUser(orgOwner.id);
      const summary = await caller.usageAnalytics.getSummary({
        ...past24hRange(),
        organizationId: testOrg.id,
        viewAs: 'self',
      });

      expect(summary.costMicrodollars).toBe(700);
      expect(summary.requestCount).toBe(1);
    });
  });

  describe('date window boundary', () => {
    it('daily tier includes today when endDate is mid-day (not midnight-aligned)', async () => {
      // Regression: before the fix, `buildWhereCommon` sliced endDate to
      // YYYY-MM-DD and used `lt(day, endDate)`, which excluded the day
      // matching endDate's calendar day (i.e. today). The UI computes
      // endDate via `new Date().toISOString()` for "30d"/"7d"/"1y"
      // selections, so the window always had a mid-day timestamp and the
      // current day's rollup row was silently missing.
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 4242,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 31);
      // Pass a mid-day endDate (now) so the daily tier must include today.
      const summary = await caller.usageAnalytics.getSummary({
        startDate: start.toISOString(),
        endDate: now.toISOString(),
        granularity: 'day',
        organizationId: testOrg.id,
      });

      expect(summary.costMicrodollars).toBe(4242);
      expect(summary.requestCount).toBe(1);
    });

    it('monthly tier includes the current partial month for "past year" windows', async () => {
      // Regression: `gte(month, startDate.slice(0, 10))` used to exclude
      // the first calendar month when startDate was mid-month (e.g. for
      // "past year"), and the current partial month needs to be included
      // even though its rollup row has day-of-month = 01.
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);
      const monthIso = `${today.slice(0, 7)}-01`;

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 9999,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);
      await processMonth(monthIso);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      // startDate mid-month one year ago; endDate mid-day now.
      const startDate = new Date(now);
      startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);

      const summary = await caller.usageAnalytics.getSummary({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'month',
        organizationId: testOrg.id,
      });

      expect(summary.costMicrodollars).toBe(9999);
      expect(summary.requestCount).toBe(1);
    });
  });

  describe('project dimension', () => {
    it('breakdown groups by project_id with "none" sentinel for NULL', async () => {
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 600,
        input_tokens: 100,
        output_tokens: 50,
        created_at: oneHourAgo,
        model: 'gpt-4',
        project_id: 'acme-web',
      });
      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 200,
        input_tokens: 50,
        output_tokens: 25,
        created_at: oneHourAgo,
        model: 'gpt-4',
        project_id: null,
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);

      const breakdown = await caller.usageAnalytics.getBreakdown({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'hour',
        organizationId: testOrg.id,
        dimension: 'project',
        metric: 'cost',
      });

      const byKey = new Map(breakdown.breakdown.map(b => [b.key, b.value]));
      expect(byKey.get('acme-web')).toBe(600);
      expect(byKey.get('none')).toBe(200);
      expect(breakdown.totalValue).toBe(800);
    });
  });

  describe('granularity=week', () => {
    it('emits week bucket as a bare YYYY-MM-DD date string', async () => {
      // Regression: the bucket expression used to cast `date_trunc('week', …)`
      // to `::text` directly, yielding a timestamp-format string that bypassed
      // the client's `isDateOnlyString` detection and shifted the week start
      // to the viewer's local timezone. The fix casts through `::date` so the
      // bucket is `YYYY-MM-DD`, which the client then formats with `UTC`.
      const today = await getTodayIsoDate();
      const oneHourAgo = await dateAt(1);

      await insertUsageWithOverrides({
        kilo_user_id: orgMember.id,
        organization_id: testOrg.id,
        cost: 42,
        input_tokens: 10,
        output_tokens: 5,
        created_at: oneHourAgo,
        model: 'gpt-4',
      });

      await processDay(today);

      const caller = await createCallerForUser(orgMember.id);
      const now = new Date();
      const startDate = new Date(now);
      startDate.setUTCDate(startDate.getUTCDate() - 7);

      const result = await caller.usageAnalytics.getTimeseries({
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
        granularity: 'week',
        organizationId: testOrg.id,
        metric: 'cost',
      });

      expect(result.timeseries.length).toBeGreaterThan(0);
      for (const point of result.timeseries) {
        expect(point.datetime).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });
});
