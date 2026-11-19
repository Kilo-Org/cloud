// The lapsed organization plan, in the two shapes every surface paints it: the
// sentence the reader's role picks, and the step when that role can take it. The
// organization hub and the providers-and-models form state the same state, so
// the choice lives here instead of being copied into each screen.
//
// `isMoneyRole` in the organization query module is `canManageOrganizationBilling`
// re-exported; the predicate is imported from the shared package directly so
// this module stays pure (the query module reaches expo-router and the query
// chain).

import {
  canManageOrganizationBilling,
  type OrganizationRole,
} from '@kilocode/app-shared/organizations';
import { type TFunction } from 'i18next';

import { openExternalUrl } from '@/lib/external-link';

/** The step a plan refusal offers under its sentence. */
export type OrganizationPlanRefusalAction = { label: string; onPress: () => void };

/** The refusal a lapsed plan paints: its sentence, and its step when one applies. */
type OrganizationPlanRefusalCopy = { message: string; action?: OrganizationPlanRefusalAction };

/**
 * The sentence and the step for a lapsed plan. The sentence follows the step
 * this call can paint, so it never leaves a reader without a next step: a role
 * that gets an action is told the state and stops there, because the action is
 * the next step; a role that gets none is told where billing is changed, in the
 * form the app's trial-refusal table uses for that role.
 *
 * The step is the web billing page when the storefront rule lets the app link
 * it, which is the page that sells the plan. A surface that has its own step for
 * the storefronts the rule refuses — the in-app billing screen, which names
 * where the plan is bought — passes it as `inAppBilling`, and it is used for
 * exactly the roles the state sentence belongs to. A caller that hands in
 * neither keeps the sentence that carries the step itself; a reader who cannot
 * change the plan keeps the sentence that names who can, with no step.
 */
export function organizationPlanRefusalFor({
  role,
  canLinkBilling,
  billingUrl,
  inAppBilling,
  t,
}: {
  role: OrganizationRole | undefined;
  canLinkBilling: boolean;
  billingUrl: string;
  /** The caller's own step, used when the storefront rule refuses the web link. */
  inAppBilling?: OrganizationPlanRefusalAction;
  t: TFunction;
}): OrganizationPlanRefusalCopy {
  const canManagePlan = canManageOrganizationBilling(role);
  // The sentence that stops at the state belongs to a step painted beside it.
  // Without one the reader gets the sentence that carries the step, and which
  // one that is follows the app's trial-refusal table: a reader who can change
  // the plan is told they can, and everyone else is told which role can.
  const stepSentence = t('organization.hub.planEnded');
  if (!canManagePlan) {
    return { message: t('common.organizationTrialEnded') };
  }
  if (!canLinkBilling) {
    return inAppBilling === undefined
      ? { message: t('common.organizationTrialEndedBilling') }
      : { message: stepSentence, action: inAppBilling };
  }
  const label = t('organization.hub.manageBilling');
  return {
    message: stepSentence,
    action: {
      label,
      onPress: () => {
        void openExternalUrl(billingUrl, { label });
      },
    },
  };
}
