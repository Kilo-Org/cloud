import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { db } from '@/lib/drizzle';
import { organizations, organization_memberships } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { DEV_ORG_ID, DEV_ORG_NAME, hosted_domain_specials } from '@/lib/auth/constants';
import { WORKOS_API_KEY } from '@/lib/config.server';
import { WorkOS } from '@workos-inc/node';
import { captureException } from '@sentry/nextjs';

const workos = new WorkOS(WORKOS_API_KEY);

export async function POST(_request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development mode' },
      { status: 403 }
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  console.log('[DEV CREATE KILOCODE ORG] Starting force recreation process', {
    userId: user.id,
    userEmail: user.google_user_email,
    devOrgId: DEV_ORG_ID,
  });

  try {
    // Force delete: Remove all memberships first
    const deletedMemberships = await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, DEV_ORG_ID))
      .returning();

    console.log('[DEV CREATE KILOCODE ORG] Deleted existing memberships', {
      count: deletedMemberships.length,
      membershipIds: deletedMemberships.map(m => m.id),
    });

    // Force delete: Remove the organization
    const deletedOrgs = await db
      .delete(organizations)
      .where(eq(organizations.id, DEV_ORG_ID))
      .returning();

    if (deletedOrgs.length > 0) {
      console.log('[DEV CREATE KILOCODE ORG] Deleted existing organization', {
        id: deletedOrgs[0].id,
        name: deletedOrgs[0].name,
      });
    } else {
      console.log('[DEV CREATE KILOCODE ORG] No existing organization to delete');
    }

    // Create fresh organization using a transaction (like normal creation)
    console.log('[DEV CREATE KILOCODE ORG] Creating new organization');
    // Set trial end date to far future to make it last forever
    const trialEndDate = new Date('9999-12-31T23:59:59Z');

    const org = await db.transaction(async tx => {
      const [organization] = await tx
        .insert(organizations)
        .values({
          id: DEV_ORG_ID, // Explicitly set the ID
          name: DEV_ORG_NAME,
          require_seats: false,
          created_by_kilo_user_id: user.id,
          free_trial_end_at: trialEndDate.toISOString(),
          sso_domain: hosted_domain_specials.kilocode_admin,
          plan: 'enterprise',
          settings: {
            enable_usage_limits: false,
            code_indexing_enabled: true,
          },
        })
        .returning();

      console.log('[DEV CREATE KILOCODE ORG] Organization created in transaction', {
        id: organization.id,
        name: organization.name,
        plan: organization.plan,
        sso_domain: organization.sso_domain,
        require_seats: organization.require_seats,
        free_trial_end_at: organization.free_trial_end_at,
        settings: organization.settings,
        deleted_at: organization.deleted_at,
        created_by_kilo_user_id: organization.created_by_kilo_user_id,
      });

      // Create membership directly in the same transaction (like normal flow)
      console.log('[DEV CREATE KILOCODE ORG] Creating membership in transaction');
      await tx.insert(organization_memberships).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        role: 'owner',
      });

      return organization;
    });

    console.log('[DEV CREATE KILOCODE ORG] Organization and membership created successfully', {
      id: org.id,
      name: org.name,
    });

    // Create Stripe customer ID (like normal flow)
    console.log('[DEV CREATE KILOCODE ORG] Creating Stripe customer ID');
    await getOrCreateStripeCustomerIdForOrganization(org.id);
    console.log('[DEV CREATE KILOCODE ORG] Stripe customer ID created');

    // Verify membership was created
    const newMembership = await db.query.organization_memberships.findFirst({
      where: and(
        eq(organization_memberships.organization_id, DEV_ORG_ID),
        eq(organization_memberships.kilo_user_id, user.id)
      ),
    });

    if (newMembership) {
      console.log('[DEV CREATE KILOCODE ORG] Membership created successfully', {
        id: newMembership.id,
        organization_id: newMembership.organization_id,
        kilo_user_id: newMembership.kilo_user_id,
        role: newMembership.role,
        created_at: newMembership.created_at,
      });
    }

    try {
      const workosOrgs = await workos.organizations.listOrganizations({
        domains: [hosted_domain_specials.kilocode_admin],
      });

      if (workosOrgs.data.length > 0) {
        const workosOrg = workosOrgs.data[0];

        // Check if it's already linked correctly and link if not
        if (workosOrg.externalId !== DEV_ORG_ID) {
          console.log('[DEV CREATE KILOCODE ORG] Linking WorkOS organization', {
            workosOrgId: workosOrg.id,
            currentExternalId: workosOrg.externalId,
            newExternalId: DEV_ORG_ID,
          });
          await workos.organizations.updateOrganization({
            organization: workosOrg.id,
            externalId: DEV_ORG_ID,
          });
          console.log('[DEV CREATE KILOCODE ORG] WorkOS organization linked successfully');
        } else {
          console.log('[DEV CREATE KILOCODE ORG] WorkOS organization already linked correctly');
        }
      } else {
        console.log('[DEV CREATE KILOCODE ORG] No WorkOS organizations found for domain', {
          domain: hosted_domain_specials.kilocode_admin,
        });
      }
    } catch (workosError) {
      // Log but don't fail - the org is created and user is added
      console.warn('[DEV CREATE KILOCODE ORG] Failed to link WorkOS organization:', workosError);
      captureException(workosError, {
        tags: { source: 'dev_create_kilocode_org' },
        extra: { userId: user.id, orgId: DEV_ORG_ID },
        level: 'warning',
      });
    }

    return NextResponse.json({
      success: true,
      organizationId: DEV_ORG_ID,
      organizationName: org.name,
    });
  } catch (_error) {
    console.error('[DEV CREATE KILOCODE ORG] ERROR:', _error);
    return NextResponse.json(
      { error: 'Failed to create Kilocode dev organization: ' + String(_error) },
      { status: 500 }
    );
  }
}
