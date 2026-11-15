// One organization refusal, read for the person who receives it.
//
// The organization subscription gate refuses every mutation with one sentence
// (`ORGANIZATION_TRIAL_EXPIRED_MESSAGE` in `server-error-copy.ts`), but the
// reader's role decides whether the copy is a dead end or a step. A reader who
// can change the plan gets copy that offers the step and an action that opens
// the in-app billing screen; everyone else keeps the copy that names the person
// who can. The key and the role read live together here so every converted
// surface asks one question and cannot drift into a third phrasing.
//
// The key table itself is in `trial-refusal-copy.ts` and re-exported below: the
// modules that only match server text import the sentence without the hooks
// this file needs, and those hooks reach expo-router and the organization query
// chain.

import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { isMoneyRole, useOrgBoundary } from '@/lib/hooks/use-organization-queries';

export {
  TRIAL_ENDED_BILLING_COPY_KEY,
  TRIAL_ENDED_COPY_KEY,
  trialRefusalCopyKey,
  trialRefusalMessage,
} from '@/lib/trial-refusal-copy';

/**
 * The organization billing screen, pushed inside the Profile tab's organization
 * Stack. This is the route `hub-screen.tsx` pushes for the Billing row, typed
 * `Href` so a moved route fails typecheck instead of silently doing nothing.
 */
export const ORGANIZATION_BILLING_HREF = '/(app)/(tabs)/(3_profile)/organization/billing' as Href;

/** The step a refusal offers under its copy. */
export type TrialRefusalAction = { label: string; onPress: () => void };

/**
 * Whether the caller's organization role may change the plan. The role comes
 * from the shared membership list, so it reads `false` until that list settles;
 * a refusal painted before then keeps the owner-naming copy and gains the step
 * on the next frame rather than offering an action the server would refuse.
 */
export function useCanManageBilling(organizationId?: string | null): boolean {
  const { role } = useOrgBoundary(organizationId ?? undefined);
  return isMoneyRole(role);
}

/**
 * The billing step for a role the caller already resolved, or `undefined` for
 * a reader the server would refuse. The hooks below are the usual way to read
 * a role; a surface whose organization id is a press-time value rather than a
 * render-time one resolves the same predicate from the shared membership list
 * and builds the step with this, so the step keeps one shape.
 */
export function billingActionFor(
  canManageBilling: boolean,
  label: string,
  openBilling: () => void
): TrialRefusalAction | undefined {
  if (!canManageBilling) {
    return undefined;
  }
  return { label, onPress: openBilling };
}

/**
 * The billing step a trial refusal offers, or `undefined` for a reader the
 * server would refuse. Both hooks run on every render: the decision is in the
 * returned value, never in whether a hook was called.
 */
export function useBillingAction(organizationId?: string | null): TrialRefusalAction | undefined {
  const canManageBilling = useCanManageBilling(organizationId);
  const router = useRouter();
  const { t } = useTranslation();
  return billingActionFor(canManageBilling, t('organization.hub.manageBilling'), () => {
    router.push(ORGANIZATION_BILLING_HREF);
  });
}

/**
 * The billing step, offered only when the rejection really is the trial
 * refusal. A surface that maps every failure on a request reads the raw error,
 * and an unrelated `FORBIDDEN` there must keep its own recovery rather than
 * gain a plan step, so the predicate the caller already computed decides
 * whether the step is published. The hook itself runs on every render.
 */
export function useTrialRefusalAction(
  isTrialRefusal: boolean,
  organizationId?: string | null
): TrialRefusalAction | undefined {
  const action = useBillingAction(organizationId);
  return isTrialRefusal ? action : undefined;
}
