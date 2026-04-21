import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { sql, isNotNull, inArray } from 'drizzle-orm';

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
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)));
  const minAccounts = Math.max(2, parseInt(searchParams.get('minAccounts') ?? '2', 10));
  const hideAllBlocked = searchParams.get('hideAllBlocked') === 'true';

  const havingClauses = [sql`count(*) >= ${minAccounts}`];
  if (hideAllBlocked) {
    // Exclude groups where every user is blocked
    havingClauses.push(sql`count(*) FILTER (WHERE ${kilocode_users.blocked_reason} IS NULL) > 1`);
  }
  const havingClause = sql.join(havingClauses, sql` AND `);

  // Count distinct normalized_email values that meet the filter criteria
  const countRows = await db
    .select({ normalized_email: kilocode_users.normalized_email })
    .from(kilocode_users)
    .where(isNotNull(kilocode_users.normalized_email))
    .groupBy(kilocode_users.normalized_email)
    .having(havingClause);

  const total = countRows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const offset = (page - 1) * limit;

  // Get the paginated set of duplicate normalized_email values
  const duplicateEmailRows = await db
    .select({ normalized_email: kilocode_users.normalized_email })
    .from(kilocode_users)
    .where(isNotNull(kilocode_users.normalized_email))
    .groupBy(kilocode_users.normalized_email)
    .having(havingClause)
    .orderBy(kilocode_users.normalized_email)
    .limit(limit)
    .offset(offset);

  if (duplicateEmailRows.length === 0) {
    return NextResponse.json({
      groups: [],
      pagination: { page, limit, total, totalPages },
    });
  }

  const emailValues = duplicateEmailRows
    .map(row => row.normalized_email)
    .filter((e): e is string => e !== null);

  // Fetch all users for those normalized emails
  const users = await db
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
    })
    .from(kilocode_users)
    .where(inArray(kilocode_users.normalized_email, emailValues))
    .orderBy(kilocode_users.normalized_email, kilocode_users.created_at);

  // Group users by normalized_email
  const groupMap = new Map<string, DuplicateUser[]>();
  for (const user of users) {
    const key = user.normalized_email;
    if (!key) continue;
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(user as DuplicateUser);
    } else {
      groupMap.set(key, [user as DuplicateUser]);
    }
  }

  const groups: DuplicateGroup[] = emailValues.map(email => ({
    normalized_email: email,
    users: groupMap.get(email) ?? [],
  }));

  return NextResponse.json({
    groups,
    pagination: { page, limit, total, totalPages },
  });
}
