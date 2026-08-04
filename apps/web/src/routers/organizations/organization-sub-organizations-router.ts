import { organization_memberships } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationBillingProcedure } from '@/routers/organizations/utils';
import { getDirectChildOrganizations } from '@/lib/organizations/organizations';
import { OrganizationPlanSchema } from '@/lib/organizations/organization-types';
import { count, inArray } from 'drizzle-orm';
import * as z from 'zod';

const SubOrganizationOverviewChildSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  plan: OrganizationPlanSchema,
  memberCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
});

const SubOrganizationsOverviewOutputSchema = z.object({
  children: z.array(SubOrganizationOverviewChildSchema),
});

export const organizationSubOrganizationsRouter = createTRPCRouter({
  // Parent-facing overview of direct child organizations. Restricted to the
  // parent's owner/billing_manager: only those roles inherit access to
  // children, so a plain parent member can never enumerate them, and a child
  // owner has no membership on the parent and is rejected at the auth gate.
  // Hierarchy is strictly single-level, so this is immediate children only.
  overview: organizationBillingProcedure
    .output(SubOrganizationsOverviewOutputSchema)
    .query(async ({ input }) => {
      const children = await getDirectChildOrganizations(input.organizationId);

      // Single batched query for member counts across every child, so the
      // query count is independent of the number of children (no N+1 fan-out).
      const childIds = children.map(child => child.id);
      const memberCountRows =
        childIds.length > 0
          ? await db
              .select({
                organizationId: organization_memberships.organization_id,
                memberCount: count(),
              })
              .from(organization_memberships)
              .where(inArray(organization_memberships.organization_id, childIds))
              .groupBy(organization_memberships.organization_id)
          : [];
      const memberCountByOrg = new Map(
        memberCountRows.map(row => [row.organizationId, Number(row.memberCount)])
      );

      return {
        children: children.map(child => ({
          id: child.id,
          name: child.name,
          plan: child.plan,
          memberCount: memberCountByOrg.get(child.id) ?? 0,
          createdAt: new Date(child.created_at).toISOString(),
        })),
      };
    }),
});
