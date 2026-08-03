import {
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_processing_runs,
  organizations,
} from '@kilocode/db/schema';
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';

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

  const [agreement] = await tx
    .select({ id: kilo_pass_org_agreements.id })
    .from(kilo_pass_org_agreements)
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organization.parentOrganizationId),
        ne(kilo_pass_org_agreements.state, 'ended')
      )
    )
    .limit(1)
    .for('update');
  if (!agreement) return;

  const plans = await tx
    .select({
      id: kilo_pass_org_allocation_plans.id,
      effectiveAt: kilo_pass_org_allocation_plans.effective_window_start,
      version: kilo_pass_org_allocation_plans.version,
    })
    .from(kilo_pass_org_allocation_plans)
    .where(eq(kilo_pass_org_allocation_plans.agreement_id, agreement.id))
    .orderBy(
      asc(kilo_pass_org_allocation_plans.effective_window_start),
      asc(kilo_pass_org_allocation_plans.version)
    )
    .for('update');
  if (!plans.length) return;

  const unresolvedRuns = await tx
    .select({ windowStart: kilo_pass_org_processing_runs.window_start })
    .from(kilo_pass_org_processing_runs)
    .leftJoin(
      kilo_pass_org_issuance_snapshots,
      and(
        eq(kilo_pass_org_issuance_snapshots.agreement_id, agreement.id),
        eq(
          kilo_pass_org_issuance_snapshots.window_start,
          kilo_pass_org_processing_runs.window_start
        )
      )
    )
    .where(
      and(
        eq(kilo_pass_org_processing_runs.agreement_id, agreement.id),
        inArray(kilo_pass_org_processing_runs.state, ['pending', 'running', 'blocked', 'failed']),
        isNull(kilo_pass_org_issuance_snapshots.id)
      )
    );

  const now = Date.now();
  const relevantPlanIds = new Set(
    plans.filter(plan => new Date(plan.effectiveAt).getTime() > now).map(plan => plan.id)
  );
  const planAt = (timestamp: string | Date) => {
    const at = new Date(timestamp).getTime();
    return plans.findLast(plan => new Date(plan.effectiveAt).getTime() <= at);
  };
  const currentPlan = planAt(new Date(now));
  if (currentPlan) relevantPlanIds.add(currentPlan.id);
  for (const run of unresolvedRuns) {
    const plan = planAt(run.windowStart);
    if (plan) relevantPlanIds.add(plan.id);
  }
  if (!relevantPlanIds.size) return;

  const [allocation] = await tx
    .select({ id: kilo_pass_org_allocation_plan_rows.id })
    .from(kilo_pass_org_allocation_plan_rows)
    .where(
      and(
        inArray(kilo_pass_org_allocation_plan_rows.allocation_plan_id, [...relevantPlanIds]),
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
