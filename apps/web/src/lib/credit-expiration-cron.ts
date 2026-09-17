import 'server-only';

import { kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { and, asc, eq, gt, inArray, isNotNull, lte, or, type SQL } from 'drizzle-orm';
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
  userBatchSize?: number;
  organizationBatchSize?: number;
  clock?: () => number;
};

type DueCursor = { at: string; id: string };

export async function runExpireCreditsCron(
  options: ExpireCreditsCronOptions = {}
): Promise<ExpireCreditsCronSummary> {
  const now = options.now ?? new Date();
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const summary: ExpireCreditsCronSummary = {
    usersExamined: 0,
    usersFailed: 0,
    organizationsExamined: 0,
    organizationsFailed: 0,
    hasMore: false,
  };
  const userBatchSize = options.userBatchSize ?? USER_BATCH_SIZE;
  const organizationBatchSize = options.organizationBatchSize ?? ORGANIZATION_BATCH_SIZE;
  let userCursor: DueCursor | null = null;
  let organizationCursor: DueCursor | null = null;
  const fullDeadline = startedAt + timeBudgetMs;
  const organizationDeadline = startedAt + Math.floor(timeBudgetMs / 2);

  const organizationsIncomplete = await drainOrganizations(organizationDeadline);
  const usersIncomplete = await drainUsers(fullDeadline);
  const organizationsStillIncomplete =
    organizationsIncomplete && clock() < fullDeadline
      ? await drainOrganizations(fullDeadline)
      : organizationsIncomplete;
  summary.hasMore = organizationsStillIncomplete || usersIncomplete;
  return summary;

  async function drainOrganizations(deadline: number): Promise<boolean> {
    if (clock() >= deadline) return false;
    while (clock() < deadline) {
      const dueOrganizations = await fetchDueOrganizations(
        now,
        organizationCursor,
        options.organizationIds,
        organizationBatchSize
      );
      if (dueOrganizations.length === 0) return false;

      const lastOrganization = dueOrganizations[dueOrganizations.length - 1];
      if (lastOrganization?.next_credit_expiration_at) {
        organizationCursor = {
          at: lastOrganization.next_credit_expiration_at,
          id: lastOrganization.id,
        };
      }
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

      if (dueOrganizations.length < organizationBatchSize) return false;
    }
    return true;
  }

  async function drainUsers(deadline: number): Promise<boolean> {
    if (clock() >= deadline) return false;
    while (clock() < deadline) {
      const dueUsers = await fetchDueUsers(now, userCursor, options.userIds, userBatchSize);
      if (dueUsers.length === 0) return false;

      for (const user of dueUsers) {
        if (clock() >= deadline) return true;
        if (user.next_credit_expiration_at) {
          userCursor = { at: user.next_credit_expiration_at, id: user.id };
        }
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

      if (dueUsers.length < userBatchSize) return false;
    }
    return true;
  }
}

async function fetchDueUsers(
  now: Date,
  cursor: DueCursor | null,
  userIds: readonly string[] | undefined,
  batchSize: number
): Promise<UserForLocalExpiration[]> {
  if (userIds && userIds.length === 0) return [];

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
        userIds ? inArray(kilocode_users.id, [...userIds]) : undefined,
        afterCursor(kilocode_users.next_credit_expiration_at, kilocode_users.id, cursor)
      )
    )
    .orderBy(asc(kilocode_users.next_credit_expiration_at), asc(kilocode_users.id))
    .limit(batchSize);
}

async function fetchDueOrganizations(
  now: Date,
  cursor: DueCursor | null,
  organizationIds: readonly string[] | undefined,
  batchSize: number
): Promise<OrganizationForExpiration[]> {
  if (organizationIds && organizationIds.length === 0) return [];

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
        organizationIds ? inArray(organizations.id, [...organizationIds]) : undefined,
        afterCursor(organizations.next_credit_expiration_at, organizations.id, cursor)
      )
    )
    .orderBy(asc(organizations.next_credit_expiration_at), asc(organizations.id))
    .limit(batchSize);

  return rows.flatMap(organization =>
    organization.next_credit_expiration_at === null
      ? []
      : [{ ...organization, next_credit_expiration_at: organization.next_credit_expiration_at }]
  );
}

function afterCursor(
  atColumn:
    | typeof kilocode_users.next_credit_expiration_at
    | typeof organizations.next_credit_expiration_at,
  idColumn: typeof kilocode_users.id | typeof organizations.id,
  cursor: DueCursor | null
): SQL | undefined {
  if (!cursor) return undefined;
  return or(gt(atColumn, cursor.at), and(eq(atColumn, cursor.at), gt(idColumn, cursor.id)));
}
