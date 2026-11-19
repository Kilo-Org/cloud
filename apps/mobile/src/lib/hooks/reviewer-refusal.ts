// The code reviewer's one read of the reader's organization role.
//
// Every code-reviewer procedure is either personal or organization-scoped, and
// the organization ones sit behind the subscription gate that refuses a lapsed
// trial with one sentence. The reader's role decides what that refusal says and
// whether it offers the plan step, so the scope-to-organization mapping and the
// role read live together here: the mutation hooks and the screens ask one
// question and cannot drift apart.

import { isPersonal } from '@/lib/code-reviewer-config';
import {
  type TrialRefusalAction,
  useBillingAction,
  useCanManageBilling,
} from '@/lib/trial-refusal';

/** What the reader's role allows, and the step a trial refusal offers them. */
export type ReviewerBillingRefusal = {
  canManageBilling: boolean;
  action: TrialRefusalAction | undefined;
};

/**
 * The organization a code-reviewer scope's mutations are made against, if any.
 * The personal scope's procedures carry no organization, so they can never hit
 * the organization trial gate and read no role.
 */
export function reviewerOrganizationId(scope: string): string | undefined {
  return isPersonal(scope) ? undefined : scope;
}

/**
 * The reader's billing role for a code-reviewer scope, and the step it can take.
 * The role comes from the shared membership list, so an unresolved list reads
 * `false`: a refusal painted before then keeps the owner-naming copy and gains
 * the step on the next frame rather than offering an action the server refuses.
 */
export function useReviewerBillingRefusal(scope: string): ReviewerBillingRefusal {
  const organizationId = reviewerOrganizationId(scope);
  return {
    canManageBilling: useCanManageBilling(organizationId),
    action: useBillingAction(organizationId),
  };
}
