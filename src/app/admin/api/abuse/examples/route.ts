import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { microdollar_usage_view, kilocode_users } from '@kilocode/db/schema';
import { desc, and, gt, lt, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ABUSE_CLASSIFICATION } from '@/types/AbuseClassification';

export type AbuseExample = {
  id: string;
  kilo_user_id: string;
  is_ja4_whitelisted: boolean;
  google_user_email: string | null;
  system_prompt_prefix: string | null;
  user_prompt_prefix: string | null;
  created_at: string | null;
  http_user_agent: string | null;
  http_x_vercel_ja4_digest: string | null;
  model: string | null;
  blocked_reason: string | null;
  user: {
    id: string;
    google_user_name: string;
    google_user_image_url: string;
  };
};

export type AbuseExamplesResponse = {
  examples: AbuseExample[];
  pagination: {
    page: number;
    pageSize: number;
  };
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<AbuseExamplesResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const trustedOnly = searchParams.get('trusted_only') === 'true';
  const adminOnly = searchParams.get('admin_only') === 'true';
  const blockedFilter = searchParams.get('blocked_filter') || 'all'; // 'blocked', 'unblocked', or 'all'
  const beforeFilter = searchParams.get('before_filter') || ''; // ISO datetime string or empty for "now"
  const accountAgeFilter = searchParams.get('account_age_filter') || 'all'; // 'new_users', 'old_users', or 'all'
  const costFilter = searchParams.get('cost_filter') || 'all'; // 'hide_free', 'min_cost', or 'all'
  const paymentStatusFilter = searchParams.get('payment_status_filter') || 'all'; // 'paid_more', 'paid_nothing', 'paid_min_or_less', or 'all'
  const stytchValidationFilter = searchParams.get('stytch_validation_filter') || 'all'; // 'has_stytch', 'no_stytch', or 'all'
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20')));

  // Build base conditions
  const baseConditions = [
    gt(microdollar_usage_view.abuse_classification, ABUSE_CLASSIFICATION.NOT_CLASSIFIED),
    isNotNull(microdollar_usage_view.user_prompt_prefix),
  ];

  // Add trusted only condition if needed
  if (trustedOnly) {
    baseConditions.push(
      eq(microdollar_usage_view.http_x_vercel_ja4_digest, 't13d1812h1_5d04281c6031_ef7df7f74e48')
    );
  }

  // Add admin only condition if needed
  if (adminOnly) {
    baseConditions.push(eq(kilocode_users.is_admin, true));
  }

  // Add before filter condition (applies to both trusted and untrusted)
  if (beforeFilter) {
    try {
      // Validate that beforeFilter is a valid ISO datetime string
      const beforeDate = new Date(beforeFilter);
      if (!isNaN(beforeDate.getTime())) {
        baseConditions.push(
          lt(microdollar_usage_view.created_at, sql`${sql.raw(`'${beforeFilter}'`)}::timestamp`)
        );
      }
    } catch (_error) {
      // Invalid date format, ignore the filter
      console.warn('Invalid before_filter date format:', beforeFilter);
    }
  }
  // If empty, no time restriction (equivalent to "now")

  // Add blocked filter condition
  if (blockedFilter === 'blocked') {
    baseConditions.push(isNotNull(kilocode_users.blocked_reason));
  } else if (blockedFilter === 'unblocked') {
    baseConditions.push(isNull(kilocode_users.blocked_reason));
  }
  // If 'all', no additional condition needed

  // Add account age filter condition
  if (accountAgeFilter === 'new_users') {
    baseConditions.push(gt(kilocode_users.created_at, sql`now() - interval '7 days'`));
  } else if (accountAgeFilter === 'old_users') {
    baseConditions.push(sql`${kilocode_users.created_at} <= now() - interval '7 days'`);
  }
  // If 'all', no additional condition needed

  // Add cost filter condition
  if (costFilter === 'hide_free') {
    baseConditions.push(gt(microdollar_usage_view.cost, 0));
  } else if (costFilter === 'min_cost') {
    // $0.10 = 100,000 microdollars
    baseConditions.push(gt(microdollar_usage_view.cost, 100000));
  }
  // If 'all', no additional condition needed

  // Add payment status filter condition
  if (paymentStatusFilter === 'paid_more') {
    // Users that have paid strictly more than minimum top-up amount
    // Using a subquery to check total non-free credit transactions > minimum threshold
    // Assuming minimum top-up is $5.00 = 5,000,000 microdollars
    baseConditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${sql.identifier('credit_transactions')} ct
        WHERE ct.kilo_user_id = ${kilocode_users.id}
        AND ct.is_free = false
        GROUP BY ct.kilo_user_id
        HAVING COALESCE(SUM(ct.amount_microdollars), 0) > 5000000
      )`
    );
  } else if (paymentStatusFilter === 'paid_nothing') {
    // Users that have paid nothing (no non-free credit transactions)
    baseConditions.push(
      sql`NOT EXISTS (
        SELECT 1 FROM ${sql.identifier('credit_transactions')} ct
        WHERE ct.kilo_user_id = ${kilocode_users.id}
        AND ct.is_free = false
      )`
    );
  } else if (paymentStatusFilter === 'paid_min_or_less') {
    // Users that have paid no more than minimum top-up amount
    baseConditions.push(
      sql`NOT EXISTS (
        SELECT 1 FROM ${sql.identifier('credit_transactions')} ct
        WHERE ct.kilo_user_id = ${kilocode_users.id}
        AND ct.is_free = false
        GROUP BY ct.kilo_user_id
        HAVING COALESCE(SUM(ct.amount_microdollars), 0) > 5000000
      )`
    );
  }
  // If 'all', no additional condition needed

  // Add Stytch validation filter condition
  if (stytchValidationFilter === 'has_stytch') {
    baseConditions.push(eq(kilocode_users.has_validation_stytch, true));
  } else if (stytchValidationFilter === 'no_stytch') {
    baseConditions.push(
      sql`(${kilocode_users.has_validation_stytch} = false OR ${kilocode_users.has_validation_stytch} IS NULL)`
    );
  }
  // If 'all', no additional condition needed

  // Note: Removed expensive total count query for performance

  const query = db
    .select({
      id: microdollar_usage_view.id,
      kilo_user_id: microdollar_usage_view.kilo_user_id,
      google_user_email: kilocode_users.google_user_email,
      system_prompt_prefix: microdollar_usage_view.system_prompt_prefix,
      user_prompt_prefix: microdollar_usage_view.user_prompt_prefix,
      created_at: microdollar_usage_view.created_at,
      http_user_agent: microdollar_usage_view.http_user_agent,
      http_x_vercel_ja4_digest: microdollar_usage_view.http_x_vercel_ja4_digest,
      model: microdollar_usage_view.model,
      user_id: kilocode_users.id,
      user_name: kilocode_users.google_user_name,
      user_image_url: kilocode_users.google_user_image_url,
      blocked_reason: kilocode_users.blocked_reason,
    })
    .from(microdollar_usage_view)
    .leftJoin(kilocode_users, eq(microdollar_usage_view.kilo_user_id, kilocode_users.id))
    .where(and(...baseConditions))
    .orderBy(desc(microdollar_usage_view.created_at))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const rawExamples = await query;

  // Transform the results to include user object
  const examples = rawExamples.map(({ user_id, user_name, user_image_url, ...rest }) => ({
    ...rest,
    // TODO: Pull this from the abuse classification service
    is_ja4_whitelisted: false,
    user: {
      id: user_id ?? rest.kilo_user_id, // Fallback to kilo_user_id if user not found
      google_user_name: user_name ?? 'Unknown User',
      google_user_image_url: user_image_url ?? '',
    },
  }));

  return NextResponse.json({
    examples,
    pagination: {
      page,
      pageSize,
    },
  });
}
