import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { fromMicrodollars } from '@/lib/utils';
import {
  organization_user_limits,
  organization_user_usage,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';

/**
 * GET /api/gateway/usage
 *
 * Returns the current user's quota/usage state for the Kilo gateway.
 * Used by third-party tools (like OpenClaw) to display usage bars and warn before hitting limits.
 *
 * Response:
 * {
 *   "limits": [{ "period": "daily", "used": 1.50, "limit": 2.00, "reset_at": "2026-03-11T00:00:00Z" }],
 *   "plan": "pro",
 *   "balance_usd": 10.50
 * }
 */
export async function GET() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Get user's organization membership
  const membership = await db
    .select({
      organizationId: organization_memberships.organization_id,
      role: organization_memberships.role,
    })
    .from(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, user.id))
    .limit(1);

  // Non-org user case
  if (!membership.length || membership[0].role === 'billing_manager') {
    return NextResponse.json({
      limits: [],
      plan: null,
      balance_usd: null,
    });
  }

  const orgId = membership[0].organizationId;

  // Query org balance, limits, and usage
  const result = await db
    .select({
      // Org info
      totalMicrodollarsAcquired: organizations.total_microdollars_acquired,
      microdollarsUsed: organizations.microdollars_used,
      plan: organizations.plan,
      // User limit (daily)
      microdollarLimit: organization_user_limits.microdollar_limit,
      // User usage (daily)
      microdollarUsage: organization_user_usage.microdollar_usage,
    })
    .from(organizations)
    .leftJoin(
      organization_user_limits,
      and(
        eq(organization_user_limits.organization_id, orgId),
        eq(organization_user_limits.kilo_user_id, user.id),
        eq(organization_user_limits.limit_type, 'daily')
      )
    )
    .leftJoin(
      organization_user_usage,
      and(
        eq(organization_user_usage.organization_id, orgId),
        eq(organization_user_usage.kilo_user_id, user.id),
        eq(organization_user_usage.limit_type, 'daily'),
        eq(organization_user_usage.usage_date, sql`CURRENT_DATE`)
      )
    )
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!result.length) {
    return NextResponse.json({
      limits: [],
      plan: null,
      balance_usd: null,
    });
  }

  const row = result[0];

  // Calculate balance: acquired - used
  const balanceUsd = fromMicrodollars(
    (row.totalMicrodollarsAcquired ?? 0) - (row.microdollarsUsed ?? 0)
  );

  // Build limits array
  const limits: Array<{
    period: string;
    used: number;
    limit: number;
    reset_at: string;
  }> = [];

  // Only include limit if user has one configured (not null = has limit)
  if (row.microdollarLimit !== null) {
    const usedUsd = fromMicrodollars(row.microdollarUsage ?? 0);
    const limitUsd = fromMicrodollars(row.microdollarLimit);

    // Compute next midnight UTC for reset_at
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    limits.push({
      period: 'daily',
      used: usedUsd,
      limit: limitUsd,
      reset_at: tomorrow.toISOString(),
    });
  }

  return NextResponse.json({
    limits,
    plan: row.plan,
    balance_usd: balanceUsd,
  });
}
