import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { organizations } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';

export const childOrganizationSettings = {
  suppress_trial_messaging: true,
};

export async function validateParentOrganizationChange(
  organizationId: string,
  parentOrganizationId: string | null,
  txn: DrizzleTransaction
) {
  const [organization] = await txn
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);

  if (!organization) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  }

  if (!parentOrganizationId) {
    return;
  }

  if (organizationId === parentOrganizationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'An organization cannot be its own parent',
    });
  }

  const [childOrganization] = await txn
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.parent_organization_id, organizationId),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);

  if (childOrganization) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Cannot add a parent to an organization that already has child organizations',
    });
  }

  let currentParentId: string | null = parentOrganizationId;
  const visitedOrganizationIds = new Set<string>();

  while (currentParentId) {
    if (currentParentId === organizationId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot create a cycle in the organization hierarchy',
      });
    }

    if (visitedOrganizationIds.has(currentParentId)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Existing organization hierarchy contains a cycle',
      });
    }
    visitedOrganizationIds.add(currentParentId);

    const [parentOrganization] = await txn
      .select({ parent_organization_id: organizations.parent_organization_id })
      .from(organizations)
      .where(and(eq(organizations.id, currentParentId), isNull(organizations.deleted_at)))
      .limit(1);

    if (!parentOrganization) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Parent organization not found',
      });
    }

    if (currentParentId === parentOrganizationId && parentOrganization.parent_organization_id) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot add child organizations to an organization that is already a child',
      });
    }

    currentParentId = parentOrganization.parent_organization_id;
  }
}

export async function createChildOrganization(name: string, parentOrganizationId: string) {
  const organization = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260624, 1)`);

    const [createdOrganization] = await tx
      .insert(organizations)
      .values({
        name,
        require_seats: false,
        free_trial_end_at: null,
        parent_organization_id: parentOrganizationId,
        settings: {
          enable_usage_limits: false,
          code_indexing_enabled: true,
          ...childOrganizationSettings,
        },
      })
      .returning();

    await validateParentOrganizationChange(createdOrganization.id, parentOrganizationId, tx);
    return createdOrganization;
  });

  await getOrCreateStripeCustomerIdForOrganization(organization.id);
  return organization;
}
