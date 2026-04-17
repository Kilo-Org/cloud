import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import {
  getEffectiveKiloClawSubscriptionForUser,
  getKiloClawEarlybirdStateForUser,
} from '@/lib/kiloclaw/access-state';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';

type UserLookupResponse = {
  users: {
    id: string;
    stripe_customer_id: string | null;
    has_kilopass: boolean;
    has_kiloclaw: boolean;
    organizations: {
      id: string;
      name: string;
      plan: OrganizationPlan;
    }[];
  }[];
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | UserLookupResponse>> {
  const { searchParams } = new URL(request.url);
  const searchTerm = searchParams.get('search')?.trim() || '';

  try {
    const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) {
      return authFailedResponse;
    }

    if (!searchTerm) {
      return NextResponse.json({ users: [] });
    }

    const users = await db
      .select({
        id: kilocode_users.id,
        stripe_customer_id: kilocode_users.stripe_customer_id,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, searchTerm))
      .limit(2); // more than one result is always considered a failure

    const usersWithOrgs = await Promise.all(
      users.map(async user => {
        const [userOrgs, hasKiloPass, hasKiloClaw] = await Promise.all([
          db
            .select({
              id: organizations.id,
              name: organizations.name,
              plan: organizations.plan,
            })
            .from(organization_memberships)
            .innerJoin(
              organizations,
              eq(organization_memberships.organization_id, organizations.id)
            )
            .where(eq(organization_memberships.kilo_user_id, user.id)),
          checkHasKiloPass(user.id),
          checkHasKiloClaw(user.id),
        ]);

        return {
          ...user,
          has_kilopass: hasKiloPass,
          has_kiloclaw: hasKiloClaw,
          organizations: userOrgs,
        };
      })
    );

    return NextResponse.json({ users: usersWithOrgs });
  } catch (error) {
    console.error('Error fetching users:', error);
    captureException(error, {
      tags: { source: 'private_user_lookup' },
      extra: { hasSearchTerm: !!searchTerm },
      level: 'error',
    });
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}

async function checkHasKiloPass(userId: string): Promise<boolean> {
  const state = await getKiloPassStateForUser(db, userId);
  if (!state) return false;
  return !isStripeSubscriptionEnded(state.status);
}

async function checkHasKiloClaw(userId: string): Promise<boolean> {
  const now = new Date();
  const { accessReason } = await getEffectiveKiloClawSubscriptionForUser(userId, now);
  if (accessReason) return true;

  const earlybirdState = await getKiloClawEarlybirdStateForUser(userId, now);
  return earlybirdState.hasAccess;
}
