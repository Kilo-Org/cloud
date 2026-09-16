import { kilocode_users, organizations } from '@kilocode/db/schema';
import { asc, lte } from 'drizzle-orm';
import pLimit from 'p-limit';

import {
  processLocalExpirations,
  processOrganizationExpirationsBatch,
} from '@/lib/creditExpiration';
import { db } from '@/lib/drizzle';

const DEFAULT_BATCH_SIZE = 250;
const USER_CONCURRENCY = 10;

export type CreditExpirationCronSummary = {
  dueUsers: number;
  expiredUsers: number;
  failedUserIds: string[];
  dueOrganizations: number;
  processedOrganizations: number;
  failedOrganizationIds: string[];
};

export async function runCreditExpirationCron(options?: {
  now?: Date;
  batchSize?: number;
}): Promise<CreditExpirationCronSummary> {
  const now = options?.now ?? new Date();
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const expirationBoundary = now.toISOString();

  const [dueUsers, dueOrganizations] = await Promise.all([
    db
      .select({
        id: kilocode_users.id,
        microdollars_used: kilocode_users.microdollars_used,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      })
      .from(kilocode_users)
      .where(lte(kilocode_users.next_credit_expiration_at, expirationBoundary))
      .orderBy(asc(kilocode_users.next_credit_expiration_at), asc(kilocode_users.id))
      .limit(batchSize),
    db
      .select({
        id: organizations.id,
        microdollars_used: organizations.microdollars_used,
        next_credit_expiration_at: organizations.next_credit_expiration_at,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
      })
      .from(organizations)
      .where(lte(organizations.next_credit_expiration_at, expirationBoundary))
      .orderBy(asc(organizations.next_credit_expiration_at), asc(organizations.id))
      .limit(batchSize),
  ]);

  const userLimit = pLimit(USER_CONCURRENCY);
  const userResults = await Promise.allSettled(
    dueUsers.map(user => userLimit(() => processLocalExpirations(user, now)))
  );
  const failedUserIds = userResults.flatMap((result, index) => {
    const user = dueUsers[index];
    return result.status === 'rejected' && user ? [user.id] : [];
  });
  const expiredUsers = userResults.filter(
    result => result.status === 'fulfilled' && result.value !== null
  ).length;

  let processedOrganizations = 0;
  let failedOrganizationIds: string[] = [];
  try {
    const organizationStates = await processOrganizationExpirationsBatch(dueOrganizations, now);
    processedOrganizations = dueOrganizations.filter(organization => {
      const state = organizationStates.get(organization.id);
      if (!state) return false;
      return (
        state.total_microdollars_acquired !== organization.total_microdollars_acquired ||
        state.next_credit_expiration_at !== organization.next_credit_expiration_at
      );
    }).length;
  } catch {
    failedOrganizationIds = dueOrganizations.map(organization => organization.id);
  }

  return {
    dueUsers: dueUsers.length,
    expiredUsers,
    failedUserIds,
    dueOrganizations: dueOrganizations.length,
    processedOrganizations,
    failedOrganizationIds,
  };
}
