import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth, isUserBlacklistedByDomain } from '@/lib/user.server';
import type { UsersApiResponse, SortableField, UserTableProps } from '@/types/admin';
import { sortableFields } from '@/types/admin';
import { describePaymentMethods, getPaymentStatusByUserIds } from '@/lib/admin-utils-serverside';
import { getUsersWithAnyFreeWelcomeCredits } from '@/lib/welcomeCredits';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  user_admin_notes,
  referral_codes,
  organization_memberships,
} from '@kilocode/db/schema';
import {
  ilike,
  or,
  asc,
  desc,
  count,
  inArray,
  eq,
  and,
  isNull,
  isNotNull,
  gt,
  exists,
  notExists,
  sql,
} from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | UsersApiResponse>> {
  // Parse query parameters outside try block for error reporting
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25')));
  const sortBy = (searchParams.get('sortBy') || 'created_at') as SortableField;
  const sortOrder = searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc';
  const searchTerm = searchParams.get('search')?.trim() || '';
  const notesSearchTerm = searchParams.get('notesSearch')?.trim() || '';
  const blockedStatus = searchParams.get('blockedStatus');
  const orgMembership = searchParams.get('orgMembership');
  const paymentStatus = searchParams.get('paymentStatus');
  const autoTopUp = searchParams.get('autoTopUp');

  try {
    // Check authentication and admin status
    const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) {
      return authFailedResponse;
    }

    const hasValidationStytch = searchParams.get('hasValidationStytch');
    const hasValidationNovelCard = searchParams.get('hasValidationNovelCard');

    // Validate sortBy field
    const sortField = sortableFields.includes(sortBy) ? sortBy : 'created_at';

    // Build where conditions
    const conditions = [];

    // User-specific search condition
    if (searchTerm) {
      const referralCodeOwnerId = (
        await db
          .select({ kilo_user_id: referral_codes.kilo_user_id })
          .from(referral_codes)
          .where(eq(referral_codes.code, searchTerm))
          .limit(1)
      )[0]?.kilo_user_id;

      conditions.push(
        or(
          ilike(kilocode_users.google_user_email, `%${searchTerm}%`),
          ilike(kilocode_users.google_user_name, `%${searchTerm}%`),
          eq(kilocode_users.id, searchTerm),
          eq(kilocode_users.stripe_customer_id, searchTerm),
          eq(kilocode_users.openrouter_upstream_safety_identifier, searchTerm),
          eq(kilocode_users.vercel_downstream_safety_identifier, searchTerm),
          ...(referralCodeOwnerId ? [eq(kilocode_users.id, referralCodeOwnerId)] : [])
        )
      );
    }

    // Notes and blocked reason search condition
    if (notesSearchTerm) {
      // Get user IDs that have matching admin notes
      const usersWithMatchingNotes = await db
        .selectDistinct({ kilo_user_id: user_admin_notes.kilo_user_id })
        .from(user_admin_notes)
        .where(ilike(user_admin_notes.note_content, `%${notesSearchTerm}%`));

      const userIdsWithMatchingNotes = usersWithMatchingNotes.map(row => row.kilo_user_id);

      conditions.push(
        or(
          ilike(kilocode_users.blocked_reason, `%${notesSearchTerm}%`),
          ...(userIdsWithMatchingNotes.length > 0
            ? [inArray(kilocode_users.id, userIdsWithMatchingNotes)]
            : [])
        )
      );
    }

    // Filter conditions
    if (hasValidationStytch === 'true') {
      conditions.push(eq(kilocode_users.has_validation_stytch, true));
    } else if (hasValidationStytch === 'false') {
      conditions.push(
        or(
          eq(kilocode_users.has_validation_stytch, false),
          isNull(kilocode_users.has_validation_stytch)
        )
      );
    }

    if (hasValidationNovelCard === 'true') {
      conditions.push(eq(kilocode_users.has_validation_novel_card_with_hold, true));
    } else if (hasValidationNovelCard === 'false') {
      conditions.push(eq(kilocode_users.has_validation_novel_card_with_hold, false));
    }

    // Blocked status filter
    if (blockedStatus === 'blocked') {
      conditions.push(isNotNull(kilocode_users.blocked_reason));
    } else if (blockedStatus === 'not_blocked') {
      conditions.push(isNull(kilocode_users.blocked_reason));
    }

    // Organization membership filter - use EXISTS subquery for performance
    if (orgMembership === 'in_org') {
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(organization_memberships)
            .where(eq(organization_memberships.kilo_user_id, kilocode_users.id))
        )
      );
    } else if (orgMembership === 'not_in_org') {
      conditions.push(
        notExists(
          db
            .select({ one: sql`1` })
            .from(organization_memberships)
            .where(eq(organization_memberships.kilo_user_id, kilocode_users.id))
        )
      );
    }

    // Payment status filter
    if (paymentStatus === 'paid') {
      conditions.push(gt(kilocode_users.total_microdollars_acquired, 0));
    } else if (paymentStatus === 'never_paid') {
      conditions.push(
        or(
          eq(kilocode_users.total_microdollars_acquired, 0),
          isNull(kilocode_users.total_microdollars_acquired)
        )
      );
    }

    // Auto top-up filter
    if (autoTopUp === 'enabled') {
      conditions.push(eq(kilocode_users.auto_top_up_enabled, true));
    } else if (autoTopUp === 'disabled') {
      conditions.push(eq(kilocode_users.auto_top_up_enabled, false));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Build order condition
    const orderFunction = sortOrder === 'asc' ? asc : desc;
    const orderCondition = orderFunction(kilocode_users[sortField]);

    const users = await db.query.kilocode_users.findMany({
      where: whereCondition,
      orderBy: orderCondition,
      limit: limit,
      offset: (page - 1) * limit,
    });

    const totalUserCountResult = await db
      .select({ count: count() })
      .from(kilocode_users)
      .where(whereCondition);

    const totalUserCount = totalUserCountResult[0]?.count || 0;

    const userIds = users.map(user => user.id);

    const paymentMethodsByUserId = await getPaymentStatusByUserIds(userIds);
    const notes =
      userIds.length <= 0
        ? []
        : await db.query.user_admin_notes.findMany({
            where: inArray(user_admin_notes.kilo_user_id, userIds),
            orderBy: desc(user_admin_notes.created_at),
          });
    const usersWithValidationCredits = await getUsersWithAnyFreeWelcomeCredits(userIds);

    const notesByUserId = Map.groupBy(notes, note => note.kilo_user_id);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalUserCount / limit);

    const usersWithPaymentStatus: UserTableProps[] = users.map(user => ({
      ...user,
      paymentMethodStatus: describePaymentMethods(
        paymentMethodsByUserId[user.id] || [],
        user,
        usersWithValidationCredits.has(user.id)
      ),
      admin_notes: notesByUserId.get(user.id)?.map(o => ({ ...o, admin_kilo_user: null })) || [],
      is_blacklisted_by_domain: isUserBlacklistedByDomain({
        google_user_email: user.google_user_email,
      }),
    }));

    const response: UsersApiResponse = {
      users: usersWithPaymentStatus,
      pagination: {
        page,
        limit,
        total: totalUserCount,
        totalPages,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching users:', error);
    captureException(error, {
      tags: { source: 'admin_list_users' },
      extra: {
        page,
        limit,
        sortBy,
        sortOrder,
        hasSearchTerm: !!searchTerm,
        hasNotesSearchTerm: !!notesSearchTerm,
        blockedStatus,
      },
      level: 'error',
    });
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}
