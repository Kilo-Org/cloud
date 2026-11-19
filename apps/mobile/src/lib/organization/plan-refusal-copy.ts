// The lapsed organization plan, in the two shapes every surface paints it: the
// sentence the reader's role picks, and the step outside the app when that role
// can take it. The organization hub and the providers-and-models form state the
// same state, so the choice lives here instead of being copied into each screen.
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
 * with the explanation, so the member still learns who can end the state. The
 * action exists only when the storefront rule lets the app link the web billing
 * page, which is the page that refuses the other roles.
 */
export function organizationPlanRefusalFor({
  role,
  canLinkBilling,
  billingUrl,
  t,
}: {
  role: OrganizationRole | undefined;
  canLinkBilling: boolean;
  billingUrl: string;
  t: TFunction;
}): OrganizationPlanRefusalCopy {
  const canManagePlan = canManageOrganizationBilling(role);
  const message = canManagePlan
    ? t('organization.hub.planEnded')
    : t('common.organizationTrialEnded');
  if (!canManagePlan || !canLinkBilling) {
    return { message };
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
