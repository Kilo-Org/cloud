import { describe, it, expect } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { kilocode_users, credit_transactions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from './helpers/user.helper';
import { insertUsageWithOverrides } from './helpers/microdollar-usage.helper';
import { tagInactiveUsersIntoCohort } from '@/scripts/d2025-02-04_cli-v1-rollout-cohort';
import { grantCreditsToCohort } from '@/scripts/d2025-02-04_cli-v1-rollout-grant';
import { subDays } from 'date-fns';

const COHORT_NAME = 'test-cli-v1-rollout';

async function getUserCohorts(userId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ cohorts: kilocode_users.cohorts })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId));
  return rows[0].cohorts;
}

async function getUserCredits(userId: string, category: string) {
  return db.select().from(credit_transactions).where(eq(credit_transactions.kilo_user_id, userId));
}

describe('CLI V1 Rollout', () => {
  describe('Phase 1: tagInactiveUsersIntoCohort', () => {
    it('should tag users who used Kilo >30 days ago but not recently', async () => {
      const user = await insertTestUser();
      // Usage from 60 days ago
      await insertUsageWithOverrides({
        kilo_user_id: user.id,
        created_at: subDays(new Date(), 60).toISOString(),
      });

      const { tagged } = await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });

      expect(tagged).toBeGreaterThanOrEqual(1);
      const cohorts = await getUserCohorts(user.id);
      expect(cohorts).toHaveProperty(COHORT_NAME);
    });

    it('should NOT tag users who used Kilo recently', async () => {
      const user = await insertTestUser();
      // Usage from 5 days ago (recent)
      await insertUsageWithOverrides({
        kilo_user_id: user.id,
        created_at: subDays(new Date(), 5).toISOString(),
      });

      await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });

      const cohorts = await getUserCohorts(user.id);
      expect(cohorts).not.toHaveProperty(COHORT_NAME);
    });

    it('should NOT tag users who never used Kilo', async () => {
      const user = await insertTestUser();
      // No usage records at all

      await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });

      const cohorts = await getUserCohorts(user.id);
      expect(cohorts).not.toHaveProperty(COHORT_NAME);
    });

    it('should NOT tag blocked users', async () => {
      const user = await insertTestUser({ blocked_reason: 'abuse' });
      await insertUsageWithOverrides({
        kilo_user_id: user.id,
        created_at: subDays(new Date(), 60).toISOString(),
      });

      await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });

      const cohorts = await getUserCohorts(user.id);
      expect(cohorts).not.toHaveProperty(COHORT_NAME);
    });

    it('should be idempotent — not re-tag already tagged users', async () => {
      const user = await insertTestUser();
      await insertUsageWithOverrides({
        kilo_user_id: user.id,
        created_at: subDays(new Date(), 60).toISOString(),
      });

      // First run
      const first = await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });
      expect(first.tagged).toBeGreaterThanOrEqual(1);

      const cohortsAfterFirst = await getUserCohorts(user.id);
      const firstTimestamp = cohortsAfterFirst[COHORT_NAME];

      // Second run — should not re-tag
      const second = await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });
      expect(second.tagged).toBe(0);

      // Timestamp should be unchanged
      const cohortsAfterSecond = await getUserCohorts(user.id);
      expect(cohortsAfterSecond[COHORT_NAME]).toBe(firstTimestamp);
    });

    it('should return count without writing in dry-run mode', async () => {
      const user = await insertTestUser();
      await insertUsageWithOverrides({
        kilo_user_id: user.id,
        created_at: subDays(new Date(), 60).toISOString(),
      });

      const { tagged } = await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: true,
      });

      expect(tagged).toBeGreaterThanOrEqual(1);

      // Should NOT have been tagged
      const cohorts = await getUserCohorts(user.id);
      expect(cohorts).not.toHaveProperty(COHORT_NAME);
    });
  });

  describe('Phase 2: grantCreditsToCohort', () => {
    it('should grant credits to cohort members', async () => {
      const user = await insertTestUser();
      // Manually tag into cohort
      await db
        .update(kilocode_users)
        .set({ cohorts: { [COHORT_NAME]: Date.now() } })
        .where(eq(kilocode_users.id, user.id));

      const result = await grantCreditsToCohort({
        cohortName: COHORT_NAME,
        creditCategory: 'cli-v1-rollout',
      });

      expect(result.granted).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBe(0);
    });

    it('should skip users who already received the credit (idempotent)', async () => {
      const user = await insertTestUser();
      await db
        .update(kilocode_users)
        .set({ cohorts: { [COHORT_NAME]: Date.now() } })
        .where(eq(kilocode_users.id, user.id));

      // First grant
      const first = await grantCreditsToCohort({
        cohortName: COHORT_NAME,
        creditCategory: 'cli-v1-rollout',
      });
      expect(first.granted).toBeGreaterThanOrEqual(1);

      // Second grant — should skip
      const second = await grantCreditsToCohort({
        cohortName: COHORT_NAME,
        creditCategory: 'cli-v1-rollout',
      });
      expect(second.skipped).toBeGreaterThanOrEqual(1);
      expect(second.granted).toBe(0);
    });

    it('should not grant to users not in the cohort', async () => {
      const user = await insertTestUser();
      // No cohort tag

      const result = await grantCreditsToCohort({
        cohortName: COHORT_NAME,
        creditCategory: 'cli-v1-rollout',
      });

      // Should not have processed this user at all
      const credits = await getUserCredits(user.id, 'cli-v1-rollout');
      const relevant = credits.filter(c => c.credit_category === 'cli-v1-rollout');
      expect(relevant).toHaveLength(0);
    });
  });

  describe('End-to-end: Phase 1 + Phase 2', () => {
    it('should tag inactive users and then grant them credits', async () => {
      const inactiveUser = await insertTestUser();
      const activeUser = await insertTestUser();
      const neverUsedUser = await insertTestUser();

      // Inactive user: usage 60 days ago
      await insertUsageWithOverrides({
        kilo_user_id: inactiveUser.id,
        created_at: subDays(new Date(), 60).toISOString(),
      });

      // Active user: usage 5 days ago
      await insertUsageWithOverrides({
        kilo_user_id: activeUser.id,
        created_at: subDays(new Date(), 5).toISOString(),
      });

      // Never-used user: no usage records

      // Phase 1: Tag
      await tagInactiveUsersIntoCohort({
        cohortName: COHORT_NAME,
        inactiveDays: 30,
        dryRun: false,
      });

      // Verify only inactive user was tagged
      expect(await getUserCohorts(inactiveUser.id)).toHaveProperty(COHORT_NAME);
      expect(await getUserCohorts(activeUser.id)).not.toHaveProperty(COHORT_NAME);
      expect(await getUserCohorts(neverUsedUser.id)).not.toHaveProperty(COHORT_NAME);

      // Phase 2: Grant
      const grantResult = await grantCreditsToCohort({
        cohortName: COHORT_NAME,
        creditCategory: 'cli-v1-rollout',
      });

      expect(grantResult.granted).toBeGreaterThanOrEqual(1);
      expect(grantResult.failed).toBe(0);

      // Verify only inactive user got credits
      const inactiveCredits = await getUserCredits(inactiveUser.id, 'cli-v1-rollout');
      expect(inactiveCredits.filter(c => c.credit_category === 'cli-v1-rollout')).toHaveLength(1);

      const activeCredits = await getUserCredits(activeUser.id, 'cli-v1-rollout');
      expect(activeCredits.filter(c => c.credit_category === 'cli-v1-rollout')).toHaveLength(0);

      const neverUsedCredits = await getUserCredits(neverUsedUser.id, 'cli-v1-rollout');
      expect(neverUsedCredits.filter(c => c.credit_category === 'cli-v1-rollout')).toHaveLength(0);
    });
  });
});
