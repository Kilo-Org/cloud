import { describe, test, expect } from '@jest/globals';
import { bulkAddCohort } from '@/lib/cohorts/bulkAddCohort';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { inArray } from 'drizzle-orm';

describe('bulkAddCohort (integration)', () => {
  test('adds users to cohort via id and email, reports not-found identifiers', async () => {
    // Arrange: create 4 users
    const uById1 = await insertTestUser();
    const uById2 = await insertTestUser();

    const unique1 = `cohort-${Date.now()}-${Math.random()}`;
    const unique2 = `cohort-${Date.now()}-${Math.random()}`;
    const uByEmail1 = await insertTestUser({ google_user_email: `${unique1}@example.com` });
    const uByEmail2 = await insertTestUser({ google_user_email: `${unique2}@example.com` });

    const ids = [uById1.id, uById2.id];
    const emails = [uByEmail1.google_user_email, uByEmail2.google_user_email];
    const nonExistent = 'non-existent-user@example.com';

    const cohortName = `test-cohort-${Date.now()}`;

    // Case A: include non-existent identifier - should still succeed but report not found
    const resA = await bulkAddCohort([...ids, ...emails, nonExistent], cohortName);
    expect(resA.success).toBe(true);
    if (resA.success) {
      expect(resA.updatedCount).toBe(4);
      expect(resA.notFoundCount).toBe(1);
      expect(resA.notFoundIdentifiers).toContain(nonExistent);
    }

    // Verify all four users have the cohort set
    const rowsA = await db
      .select({ id: kilocode_users.id, cohorts: kilocode_users.cohorts })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [uById1.id, uById2.id, uByEmail1.id, uByEmail2.id]));

    for (const r of rowsA) {
      expect(r.cohorts).toHaveProperty(cohortName);
      expect(typeof r.cohorts[cohortName]).toBe('number');
      // Timestamp should be recent (within last minute)
      const now = Math.floor(Date.now() / 1000);
      expect(r.cohorts[cohortName]).toBeGreaterThan(now - 60);
      expect(r.cohorts[cohortName]).toBeLessThanOrEqual(now + 1);
    }
  });

  test('fails when no valid users found', async () => {
    const result = await bulkAddCohort(['non-existent-1', 'non-existent-2'], 'test-cohort');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/No users found/);
    }
  });

  test('fails with empty cohort name', async () => {
    const user = await insertTestUser();
    const result = await bulkAddCohort([user.id], '   ');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Cohort name cannot be empty/);
    }
  });

  test('fails with empty user identifiers', async () => {
    const result = await bulkAddCohort([], 'test-cohort');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/No valid user identifiers/);
    }
  });

  test('preserves existing cohorts when adding new one', async () => {
    const existingCohort = `existing-${Date.now()}`;
    const newCohort = `new-${Date.now()}`;

    // Create user with existing cohort
    const user = await insertTestUser({
      cohorts: { [existingCohort]: 1234567890 },
    });

    // Add to new cohort
    const result = await bulkAddCohort([user.id], newCohort);
    expect(result.success).toBe(true);

    // Verify both cohorts exist
    const [updatedUser] = await db
      .select({ cohorts: kilocode_users.cohorts })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [user.id]));

    expect(updatedUser.cohorts).toHaveProperty(existingCohort);
    expect(updatedUser.cohorts[existingCohort]).toBe(1234567890);
    expect(updatedUser.cohorts).toHaveProperty(newCohort);
    expect(typeof updatedUser.cohorts[newCohort]).toBe('number');
  });
});
