import 'server-only';

import { kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { and, asc, inArray, isNotNull, lte, notInArray, type SQL } from 'drizzle-orm';
import {
  processLocalExpirations,
  processOrganizationExpirationsBatch,
  type OrganizationForExpiration,
  type UserForLocalExpiration,
} from '@/lib/creditExpiration';
import { sentryLogger } from '@/lib/utils.server';

const USER_BATCH_SIZE = 50;
const ORGANIZATION_BATCH_SIZE = 100;
const DEFAULT_TIME_BUDGET_MS = 45_000;

export type ExpireCreditsCronSummary = {
  usersExamined: number;
  usersFailed: number;
  organizationsExamined: number;
  organizationsFailed: number;
  hasMore: boolean;
};

type ExpireCreditsCronOptions = {
  now?: Date;
  userIds?: readonly string[];
  organizationIds?: readonly string[];
  timeBudgetMs?: number;
};

export async function runExpireCreditsCron(
  options: ExpireCreditsCronOptions = {}
): Promise<ExpireCreditsCronSummary> {
  const now = options.now ?? new Date();
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startedAt = Date.now();
  const summary: ExpireCreditsCronSummary = {
    usersExamined: 0,
    usersFailed: 0,
    organizationsExamined: 0,
    organizationsFailed: 0,
    hasMore: false,
  };
  const skippedUserIds = new Set<string>();
  const skippedOrganizationIds = new Set<string>();
  const outOfTime = () => Date.now() - startedAt >= timeBudgetMs;

  while (!outOfTime()) {
    const dueUsers = await fetchDueUsers(now, skippedUserIds, options.userIds);
    const dueOrganizations = await fetchDueOrganizations(
      now,
      skippedOrganizationIds,
      options.organizationIds
    );
    if (dueUsers.length === 0 && dueOrganizations.length === 0) break;

    for (const user of dueUsers) {
      if (outOfTime()) {
        summary.hasMore = true;
        break;
      }
      skippedUserIds.add(user.id);
      summary.usersExamined += 1;
      try {
        await processLocalExpirations(user, now);
      } catch (error) {
        summary.usersFailed += 1;
        sentryLogger('expire-credits-cron', 'error')('failed to expire user credits', {
          kilo_user_id: user.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    if (!summary.hasMore && dueOrganizations.length > 0) {
      for (const organization of dueOrganizations) skippedOrganizationIds.add(organization.id);
      summary.organizationsExamined += dueOrganizations.length;
      try {
        await processOrganizationExpirationsBatch(dueOrganizations, now);
      } catch (error) {
        summary.organizationsFailed += dueOrganizations.length;
        sentryLogger('expire-credits-cron', 'error')('failed to expire organization credits', {
          organization_ids: dueOrganizations.map(organization => organization.id),
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    const usersRemain = dueUsers.length === USER_BATCH_SIZE;
    const organizationsRemain = dueOrganizations.length === ORGANIZATION_BATCH_SIZE;
    if (!usersRemain && !organizationsRemain) break;
    if (outOfTime()) summary.hasMore = true;
  }

  return summary;
}

async function fetchDueUsers(
  now: Date,
  skippedUserIds: ReadonlySet<string>,
  userIds: readonly string[] | undefined
): Promise<UserForLocalExpiration[]> {
  const idFilter = scopedIdFilter(kilocode_users.id, userIds, skippedUserIds);
  if (idFilter === null) return [];

  return db
    .select({
      id: kilocode_users.id,
      microdollars_used: kilocode_users.microdollars_used,
      next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      updated_at: kilocode_users.updated_at,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
    })
    .from(kilocode_users)
    .where(
      and(
        isNotNull(kilocode_users.next_credit_expiration_at),
        lte(kilocode_users.next_credit_expiration_at, now.toISOString()),
        idFilter
      )
    )
    .orderBy(asc(kilocode_users.next_credit_expiration_at))
    .limit(USER_BATCH_SIZE);
}

async function fetchDueOrganizations(
  now: Date,
  skippedOrganizationIds: ReadonlySet<string>,
  organizationIds: readonly string[] | undefined
): Promise<OrganizationForExpiration[]> {
  const idFilter = scopedIdFilter(organizations.id, organizationIds, skippedOrganizationIds);
  if (idFilter === null) return [];

  const rows = await db
    .select({
      id: organizations.id,
      microdollars_used: organizations.microdollars_used,
      next_credit_expiration_at: organizations.next_credit_expiration_at,
      total_microdollars_acquired: organizations.total_microdollars_acquired,
    })
    .from(organizations)
    .where(
      and(
        isNotNull(organizations.next_credit_expiration_at),
        lte(organizations.next_credit_expiration_at, now.toISOString()),
        idFilter
      )
    )
    .orderBy(asc(organizations.next_credit_expiration_at))
    .limit(ORGANIZATION_BATCH_SIZE);

  return rows.flatMap(organization =>
    organization.next_credit_expiration_at === null
      ? []
      : [{ ...organization, next_credit_expiration_at: organization.next_credit_expiration_at }]
  );
}

function scopedIdFilter(
  column: typeof kilocode_users.id | typeof organizations.id,
  ids: readonly string[] | undefined,
  skippedIds: ReadonlySet<string>
): SQL | undefined | null {
  if (ids) {
    const remaining = ids.filter(id => !skippedIds.has(id));
    if (remaining.length === 0) return null;
    return inArray(column, remaining);
  }
  if (skippedIds.size === 0) return undefined;
  return notInArray(column, [...skippedIds]);
}
