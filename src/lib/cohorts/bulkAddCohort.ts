import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { inArray, or, sql } from 'drizzle-orm';
import { successResult, type CustomResult } from '@/lib/maybe-result';

export type BulkAddCohortResponse = CustomResult<
  { updatedCount: number; notFoundCount: number; notFoundIdentifiers: string[] },
  { error: string }
>;

/**
 * Adds users to a cohort by updating the cohorts JSONB field.
 * The cohort value is stored as a timestamp (epoch seconds) indicating when the user was added.
 *
 * @param userIdentifiers - Array of user IDs or emails
 * @param cohortName - The cohort name to add users to
 * @returns Result with update counts and any not-found identifiers
 */
export async function bulkAddCohort(
  userIdentifiers: string[],
  cohortName: string
): Promise<BulkAddCohortResponse> {
  const trimmedCohortName = cohortName.trim();
  if (!trimmedCohortName) {
    return { success: false, error: 'Cohort name cannot be empty' };
  }

  const idsOrEmails = [...new Set(userIdentifiers.map(id => id.trim()).filter(Boolean))];

  if (idsOrEmails.length === 0) {
    return { success: false, error: 'No valid user identifiers provided' };
  }

  // Find existing users by ID or email
  const existing = await db
    .select({
      id: kilocode_users.id,
      google_user_email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(
      or(
        inArray(kilocode_users.id, idsOrEmails),
        inArray(kilocode_users.google_user_email, idsOrEmails)
      )
    );

  const existingSet = new Set(existing.flatMap(r => [r.id, r.google_user_email]));
  const notFoundIdentifiers = idsOrEmails.filter(id => !existingSet.has(id));
  const validUserIds = existing.map(r => r.id);

  if (validUserIds.length === 0) {
    return {
      success: false,
      error: `No users found for the provided identifiers. Not found: ${notFoundIdentifiers.slice(0, 10).join(', ')}${notFoundIdentifiers.length > 10 ? ` …(+${notFoundIdentifiers.length - 10} more)` : ''}`,
    };
  }

  // Update cohorts JSONB field using jsonb_set to add/update the cohort with current timestamp
  const timestamp = Math.floor(Date.now() / 1000);
  await db
    .update(kilocode_users)
    .set({
      cohorts: sql`jsonb_set(COALESCE(${kilocode_users.cohorts}, '{}'::jsonb), ${sql.raw(`'{${trimmedCohortName}}'`)}, ${sql.raw(`'${timestamp}'`)})`,
    })
    .where(inArray(kilocode_users.id, validUserIds));

  return successResult({
    updatedCount: validUserIds.length,
    notFoundCount: notFoundIdentifiers.length,
    notFoundIdentifiers: notFoundIdentifiers.slice(0, 100), // Limit to first 100 for response size
  });
}
