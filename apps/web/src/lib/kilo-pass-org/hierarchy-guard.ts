import {
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_allocation_plans,
  organizations,
} from '@kilocode/db/schema';
import { and, desc, eq, gt, ne } from 'drizzle-orm';

import type { DrizzleTransaction } from '@/lib/drizzle';

export const KILO_PASS_ORG_HIERARCHY_ALLOCATION_ERROR =
  'Cannot change organization hierarchy while it has Kilo Pass allocations';

/**
 * Rejects moving, detaching, or archiving a child whose current parent has a
 * non-ended Kilo Pass agreement that allocates at least one pass to that child.
 * Allocation plans cover both the initial allocation and future windows; issued
 * credit records are intentionally not part of this check.
 */
export async function assertOrganizationHierarchyChangeAllowed(
  tx: DrizzleTransaction,
  organizationId: string,
  nextParentOrganizationId?: string | null
): Promise<void> {
  const [organization] = await tx
    .select({ parentOrganizationId: organizations.parent_organization_id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update');

  if (!organization?.parentOrganizationId) {
    return;
  }

  if (nextParentOrganizationId === organization.parentOrganizationId) {
    return;
  }

  const [latestPlan] = await tx
    .select({ id: kilo_pass_org_allocation_plans.id })
    .from(kilo_pass_org_agreements)
    .innerJoin(
      kilo_pass_org_allocation_plans,
      eq(kilo_pass_org_allocation_plans.agreement_id, kilo_pass_org_agreements.id)
    )
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organization.parentOrganizationId),
        ne(kilo_pass_org_agreements.state, 'ended')
      )
    )
    .orderBy(desc(kilo_pass_org_allocation_plans.version))
    .limit(1)
    .for('update');

  if (!latestPlan) return;
  const [allocation] = await tx
    .select({ id: kilo_pass_org_allocation_plan_rows.id })
    .from(kilo_pass_org_allocation_plan_rows)
    .where(
      and(
        eq(kilo_pass_org_allocation_plan_rows.allocation_plan_id, latestPlan.id),
        eq(kilo_pass_org_allocation_plan_rows.allocation_container_organization_id, organizationId),
        gt(kilo_pass_org_allocation_plan_rows.pass_capacity, 0)
      )
    )
    .limit(1)
    .for('update');

  if (allocation) {
    throw new Error(KILO_PASS_ORG_HIERARCHY_ALLOCATION_ERROR);
  }
}
