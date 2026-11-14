// The sonner step a trial refusal offers, in the shape `announcingToast`
// forwards to the toast.
//
// A `TrialRefusalAction` is an element's callback and spells it `onPress`;
// sonner spells the toast's `onClick`. One converter keeps every toast surface
// identical, and a refusal with no step stays on the adapter's bare-copy call:
// a toast carrying no options is not the same call as one carrying `undefined`.

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type TrialRefusalAction } from '@/lib/trial-refusal';

/**
 * Reports a rejected action with the message its reader gets, adding the step
 * that ends a trial refusal only when the reader can take it. A toast with no
 * step keeps the adapter's bare-copy call.
 */
export function announceTrialRefusal(
  message: string,
  action: TrialRefusalAction | undefined,
  isTrialRefusal: boolean
): void {
  if (!isTrialRefusal || action === undefined) {
    announcingToast.error(message);
    return;
  }
  announcingToast.error(message, {
    action: { label: action.label, onClick: action.onPress },
  });
}
