import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/drizzle';
import { kilocode_users, credit_transactions } from '@kilocode/db/schema';
import { asc, count, desc, ilike, eq } from 'drizzle-orm';
import { describePaymentMethods, getPaymentStatusByUserIds } from '@/lib/admin-utils-serverside';
import { getUsersWithAnyFreeWelcomeCredits } from '@/lib/welcomeCredits';
import type {
  CreditCategoryUsersApiResponse,
  CreditTransactionWithUser,
} from '@/lib/PromoCreditCategoryConfig';
import { toGuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';
import { promoCreditCategoriesByKey } from '@/lib/promoCreditCategories';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
): Promise<NextResponse<{ error: string } | CreditCategoryUsersApiResponse>> {
  const { key } = await params;
  const searchParams = request.nextUrl.searchParams;
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '25');
  const search = searchParams.get('search') || '';
  const sortBy = searchParams.get('sortBy') || 'created_at';
  const sortOrder = searchParams.get('sortOrder') || 'desc';

  const creditCategoryConfig = promoCreditCategoriesByKey.get(key);
  if (!creditCategoryConfig && key !== '<null:paid>') {
    return NextResponse.json({ error: 'Credit category not found' }, { status: 404 });
  }

  const creditCategory = creditCategoryConfig
    ? toGuiCreditCategory(creditCategoryConfig)
    : {
        credit_category: 'paid',
        adminUI_label: 'Paid Credits',
        description: 'Credits purchased by users',
        customer_requirement_name: undefined,
        organization_requirement_name: undefined,
      };

  const fieldMap = {
    google_user_name: kilocode_users.google_user_name,
    google_user_email: kilocode_users.google_user_email,
    created_at: kilocode_users.created_at,
    microdollars_used: kilocode_users.microdollars_used,
  };

  const dbSortField =
    sortBy in fieldMap ? fieldMap[sortBy as keyof typeof fieldMap] : kilocode_users.created_at;
  const dbSortOrder = sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';
  const offset = (page - 1) * limit;

  const creditCategoryFilter =
    key === '<null:paid>'
      ? sql`${credit_transactions.credit_category} IS NULL`
      : eq(credit_transactions.credit_category, key);
  const completeFilter = search
    ? sql`${creditCategoryFilter} AND ${ilike(kilocode_users.google_user_email, `%${search}%`)}`
    : creditCategoryFilter;

  const usersQuery = db
    .select({
      id: kilocode_users.id,
      google_user_image_url: kilocode_users.google_user_image_url,
      google_user_name: kilocode_users.google_user_name,
      google_user_email: kilocode_users.google_user_email,
      created_at: kilocode_users.created_at,
      has_validation_novel_card_with_hold: kilocode_users.has_validation_novel_card_with_hold,
      microdollars_used: kilocode_users.microdollars_used,
      is_admin: kilocode_users.is_admin,
      transaction_amount: credit_transactions.amount_microdollars,
      transaction_date: credit_transactions.created_at,
      credit_transaction_id: credit_transactions.id,
    })
    .from(kilocode_users)
    .innerJoin(credit_transactions, eq(kilocode_users.id, credit_transactions.kilo_user_id))
    .where(completeFilter)
    .orderBy(dbSortOrder === 'asc' ? asc(dbSortField) : desc(dbSortField))
    .limit(limit)
    .offset(offset);

  const totalQuery = db
    .select({ count: count() })
    .from(kilocode_users)
    .innerJoin(credit_transactions, eq(kilocode_users.id, credit_transactions.kilo_user_id))
    .where(completeFilter);

  const [users, totalResult] = await Promise.all([usersQuery, totalQuery]);
  const total = totalResult[0].count;
  const userIds = users.map(user => user.id);
  const paymentMethodsByUserId = await getPaymentStatusByUserIds(userIds);
  const usersWithValidationCredits = await getUsersWithAnyFreeWelcomeCredits(userIds);

  const adminUsers: CreditTransactionWithUser[] = users.map(user => ({
    kilo_user_id: user.id,
    google_user_image_url: user.google_user_image_url,
    google_user_name: user.google_user_name,
    google_user_email: user.google_user_email,
    created_at: user.created_at,
    microdollars_used: user.microdollars_used,
    is_admin: user.is_admin,
    transaction_amount: user.transaction_amount,
    transaction_date: user.transaction_date,
    credit_transaction_id: user.credit_transaction_id,
    paymentMethodStatus: describePaymentMethods(
      paymentMethodsByUserId[user.id] || [],
      user,
      usersWithValidationCredits.has(user.id)
    ),
  }));

  const totalPages = Math.ceil(total / limit);

  return NextResponse.json({
    creditCategory,
    users: adminUsers,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  });
}
