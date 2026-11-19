// The trial refusal's copy, free of the role read that picks between the two
// sentences.
//
// `server-error-copy.ts` resolves the trial refusal for every consumer that maps
// a server sentence, and many of those run in the pure test project, which has
// no Expo build. `trial-refusal.ts` holds the hooks that read the reader's role,
// so it reaches expo-router and the organization query chain; keeping the key
// table here means a sentence table never pulls the navigation stack or the Expo
// runtime into the modules that only match server text.
//
// `trial-refusal.ts` re-exports these, so the published surface stays one module.

import { i18n } from '@/i18n';

/** The copy every reader sees: it names the owner who can change the plan. */
export const TRIAL_ENDED_COPY_KEY = 'common.organizationTrialEnded';

/** The copy a reader who can change the plan sees: it offers the step. */
export const TRIAL_ENDED_BILLING_COPY_KEY = 'common.organizationTrialEndedBilling';

/** The catalog key for the trial refusal this reader can act on. */
export function trialRefusalCopyKey(canManageBilling: boolean): string {
  return canManageBilling ? TRIAL_ENDED_BILLING_COPY_KEY : TRIAL_ENDED_COPY_KEY;
}

/** The translated trial refusal for this reader. */
export function trialRefusalMessage(canManageBilling: boolean): string {
  return i18n.t(trialRefusalCopyKey(canManageBilling));
}
