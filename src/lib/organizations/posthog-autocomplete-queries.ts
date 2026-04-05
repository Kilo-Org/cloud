import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import * as z from 'zod';
import { posthogQuery } from '@/lib/posthog-query';
import type { Organization } from '@kilocode/db/schema';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch autocomplete accepted suggestions count from PostHog per day for given users
 * Returns the count of accepted suggestions for each user per day
 */
export async function getAutocompleteAcceptedSuggestionsPerDay(params: {
  organizationId: Organization['id'];
  userEmails: string[];
  startDate: string;
  endDate: string;
}): Promise<Array<{ userId: string; date: string; acceptedCount: number }>> {
  const { organizationId, userEmails, startDate, endDate } = params;

  // Guard against empty userEmails array
  if (userEmails.length === 0) {
    return [];
  }

  // Validate organizationId is a valid UUID to prevent SQL injection
  if (!UUID_REGEX.test(organizationId)) {
    console.error(
      '[getAutocompleteAcceptedSuggestionsPerDay] Invalid organizationId:',
      organizationId
    );
    return [];
  }

  // Parse dates for validation and SQL injection prevention
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Build the PostHog query - simply count accepted suggestions
  // Always group by day (not hour)
  // Use parseDateTimeBestEffort to handle ISO 8601 datetime strings
  // Use the parsed Date objects to prevent SQL injection
  const query = `
    SELECT
      toStartOfDay(timestamp) AS time_bucket,
      distinct_id,
      count(*) AS accept_count

    FROM events
    WHERE timestamp >= parseDateTimeBestEffort('${start.toISOString()}')
      AND timestamp <= parseDateTimeBestEffort('${end.toISOString()}')
      AND properties.kilocodeOrganizationId = '${organizationId}'
      AND event = 'Autocomplete Accept Suggestion'
    GROUP BY time_bucket, distinct_id
    ORDER BY time_bucket
  `;

  const response = await posthogQuery('autocomplete-accepted-suggestions', query);

  if (response.status === 'error') {
    console.error(
      '[getAutocompleteAcceptedSuggestionsPerDay] PostHog query failed:',
      response.error
    );
    // Return empty array on error to avoid breaking the entire adoption calculation
    return [];
  }

  // Define schema for PostHog query results
  const PostHogResultSchema = z.tuple([
    z.string(), // time_bucket
    z.string(), // distinct_id (email)
    z.number(), // accept_count
  ]);

  const PostHogResultsSchema = z.array(PostHogResultSchema);

  // Validate and parse the results
  const parseResult = PostHogResultsSchema.safeParse(response.body.results ?? []);
  if (!parseResult.success) {
    console.error(
      '[getAutocompleteAcceptedSuggestionsPerDay] Failed to parse PostHog results:',
      parseResult.error
    );
    return [];
  }

  const results = parseResult.data;

  // Map email addresses to user IDs
  const emailToUserId = new Map<string, string>();
  const users = await db
    .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(inArray(kilocode_users.google_user_email, userEmails));

  users.forEach(user => {
    if (user.email) {
      emailToUserId.set(user.email, user.id);
    }
  });

  // Transform results to match expected format
  return results
    .map(([timeBucket, email, acceptCount]) => {
      const userId = emailToUserId.get(email);
      if (!userId) return null;

      // Format date to match PostgreSQL DATE format (YYYY-MM-DD)
      const date = new Date(timeBucket).toISOString().split('T')[0];

      return {
        userId,
        date,
        acceptedCount: acceptCount,
      };
    })
    .filter(
      (item): item is { userId: string; date: string; acceptedCount: number } => item !== null
    );
}
