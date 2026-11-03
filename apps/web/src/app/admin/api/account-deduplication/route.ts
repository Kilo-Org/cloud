import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { sql, isNotNull, inArray, lte } from 'drizzle-orm';
import * as z from 'zod';
import { MAX_PAGE_NUMBER } from '@kilocode/web-shared/types/pagination';

/** Accounts returned for one normalized email; larger groups state their full count. */
export const MAX_ACCOUNTS_PER_GROUP = 50;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_ACCOUNTS = 2;

const listingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE_NUMBER).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  minAccounts: z.coerce.number().int().min(MIN_ACCOUNTS).default(MIN_ACCOUNTS),
});

// An absent or empty query parameter keeps the default value.
const readOptionalParam = (searchParams: URLSearchParams, name: string) => {
  const value = searchParams.get(name);
  if (value === null || value.trim() === '') return undefined;
  return value;
};

type DuplicateUser = {
  id: string;
  google_user_email: string;
  normalized_email: string;
  google_user_name: string;
  google_user_image_url: string;
  created_at: string;
  blocked_reason: string | null;
  microdollars_used: number;
  total_microdollars_acquired: number;
};

type DuplicateGroup = {
  normalized_email: string;
  account_count: number;
  users: DuplicateUser[];
};

export type AccountDeduplicationResponse = {
  groups: DuplicateGroup[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<AccountDeduplicationResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const searchParams = request.nextUrl.searchParams;
  const parsedQuery = listingQuerySchema.safeParse({
    page: readOptionalParam(searchParams, 'page'),
    limit: readOptionalParam(searchParams, 'limit'),
    minAccounts: readOptionalParam(searchParams, 'minAccounts'),
  });
  if (!parsedQuery.success) {
    return NextResponse.json({ error: 'Invalid query parameters' }, { status: 400 });
  }
  const { page, limit, minAccounts } = parsedQuery.data;
  const hideAllBlocked = searchParams.get('hideAllBlocked') === 'true';

  const havingClauses = [sql`count(*) >= ${minAccounts}`];
  if (hideAllBlocked) {
    // Exclude groups where every user is blocked
    havingClauses.push(sql`count(*) FILTER (WHERE ${kilocode_users.blocked_reason} IS NULL) > 0`);
  }
  const havingClause = sql.join(havingClauses, sql` AND `);

  const duplicateGroups = readDb
    .select({ normalized_email: kilocode_users.normalized_email })
    .from(kilocode_users)
    .where(isNotNull(kilocode_users.normalized_email))
    .groupBy(kilocode_users.normalized_email)
    .having(havingClause)
    .as('duplicate_groups');

  const offset = (page - 1) * limit;

  const [countResult, duplicateEmailRows] = await Promise.all([
    readDb.select({ total: sql<number>`count(*)::int` }).from(duplicateGroups),
    readDb
      .select({ normalized_email: duplicateGroups.normalized_email })
      .from(duplicateGroups)
      .orderBy(duplicateGroups.normalized_email)
      .limit(limit)
      .offset(offset),
  ]);

  const total = countResult[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const emailValues = duplicateEmailRows
    .map(row => row.normalized_email)
    .filter((e): e is string => e !== null);

  if (emailValues.length === 0) {
    return NextResponse.json({
      groups: [],
      pagination: { page, limit, total, totalPages },
    });
  }

  const rankedAccounts = readDb
    .select({
      id: kilocode_users.id,
      google_user_email: kilocode_users.google_user_email,
      normalized_email: kilocode_users.normalized_email,
      google_user_name: kilocode_users.google_user_name,
      google_user_image_url: kilocode_users.google_user_image_url,
      created_at: kilocode_users.created_at,
      blocked_reason: kilocode_users.blocked_reason,
      microdollars_used: kilocode_users.microdollars_used,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      account_rank:
        sql<number>`row_number() over (partition by ${kilocode_users.normalized_email} order by ${kilocode_users.created_at}, ${kilocode_users.id})`.as(
          'account_rank'
        ),
      account_count:
        sql<number>`count(*) over (partition by ${kilocode_users.normalized_email})::int`.as(
          'account_count'
        ),
    })
    .from(kilocode_users)
    .where(inArray(kilocode_users.normalized_email, emailValues))
    .as('ranked_accounts');

  const users = await readDb
    .select({
      id: rankedAccounts.id,
      google_user_email: rankedAccounts.google_user_email,
      normalized_email: rankedAccounts.normalized_email,
      google_user_name: rankedAccounts.google_user_name,
      google_user_image_url: rankedAccounts.google_user_image_url,
      created_at: rankedAccounts.created_at,
      blocked_reason: rankedAccounts.blocked_reason,
      microdollars_used: rankedAccounts.microdollars_used,
      total_microdollars_acquired: rankedAccounts.total_microdollars_acquired,
      account_count: rankedAccounts.account_count,
    })
    .from(rankedAccounts)
    .where(lte(rankedAccounts.account_rank, MAX_ACCOUNTS_PER_GROUP))
    .orderBy(rankedAccounts.normalized_email, rankedAccounts.created_at, rankedAccounts.id);

  const groupMap = new Map<string, { accountCount: number; users: DuplicateUser[] }>();
  for (const { account_count, normalized_email, ...account } of users) {
    if (!normalized_email) continue;
    const user: DuplicateUser = { ...account, normalized_email };
    const existing = groupMap.get(normalized_email);
    if (existing) {
      existing.users.push(user);
    } else {
      groupMap.set(normalized_email, { accountCount: account_count, users: [user] });
    }
  }

  const groups: DuplicateGroup[] = emailValues.map(email => {
    const group = groupMap.get(email);
    return {
      normalized_email: email,
      account_count: group?.accountCount ?? 0,
      users: group?.users ?? [],
    };
  });

  return NextResponse.json({
    groups,
    pagination: { page, limit, total, totalPages },
  });
}
