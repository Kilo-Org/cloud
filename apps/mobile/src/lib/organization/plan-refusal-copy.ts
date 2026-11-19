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
 * The sentence and the step for a lapsed plan. A role that can change the plan
 * gets the sentence that stops at the state, because the action beside it is
 * the next step; every other role gets the sentence the rest of the app shows
 * with the explanation, so the member still learns who can end the state.
 *
 * The step is the web billing page when the storefront rule lets the app link
 * it, which is the page that sells the plan. A surface that has its own step for
 * the storefronts the rule refuses — the in-app billing screen, which names
 * where the plan is bought — passes it as `inAppBilling`, and it is used for
 * exactly the roles the state sentence belongs to. A caller without one leaves
 * that role with the state sentence alone; a reader who cannot change the plan
 * keeps the sentence that names who can, with no step either way.
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
  const message = canManagePlan
    ? t('organization.hub.planEnded')
    : t('common.organizationTrialEnded');
  if (!canManagePlan) {
    return { message };
  }
  if (!canLinkBilling) {
    return inAppBilling === undefined ? { message } : { message, action: inAppBilling };
  }
  const label = t('organization.hub.manageBilling');
  return {
    message,
    action: {
      label,
      onPress: () => {
        void openExternalUrl(billingUrl, { label });
      },
    },
  };
}
