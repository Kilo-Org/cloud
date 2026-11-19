import { Alert, AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { type BriefingEstimate } from '@kilocode/app-shared/agent-briefing';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { type SurfaceAttempt } from '@/lib/surface-feedback';
import { briefingEstimateUnavailableKey } from '@/lib/agent-briefing-state';
import { briefingMoney } from '@/lib/agent-briefing-format';
import { formatNumber } from '@/lib/format';

/**
 * The enable flow reports every outcome as a toast or the platform dialog, so
 * its surface never holds a failure: the type exists only to instantiate the
 * store whose pending phase is the admission guard.
 */
type EnableSurfaceFailure = { readonly kind: 'reported-as-a-toast' };

/** A disclosure names the limit to the nearest hundredth of a minute, so a
 * duration that is not a whole number of minutes reads as `0.13`, not as the
 * full quotient. Locale formatting supplies the decimal separator. */
const SAFEGUARD_DISCLOSURE_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 2 };

export type BriefingEnableFlowInput = {
  readonly valid: boolean;
  readonly refetch: () => Promise<{ data: BriefingEstimate | undefined }>;
  readonly contextName: string;
  readonly locale: string;
  readonly language: string;
  readonly confirm: (estimateToken: string) => void;
};

/**
 * One confirm-and-enable flow per card, behind the surface-feedback admission
 * guard. Every exit settles the attempt itself: a toast outcome with
 * `abandon()` before the dialog, an Android dismissal through the dialog's
 * `onDismiss`, and — because `Alert.alert` is not awaited and the dialog
 * outlives this async function — the cancel path and the confirmed enable
 * settle it inside their own handlers. The flow refuses to present while the
 * app is not in front, because an alert dropped for want of an activity runs no
 * callback at all and would leave the card busy for the life of the mount. The
 * paid enable only runs after `owns()` and the auth epoch say this attempt
 * still owns the card, so a slow refetch whose card unmounted (the store's
 * `invalidateAll` on unmount), a superseded attempt, or a changed account
 * cannot present a dialog or fire the paid write. Nothing persists on the
 * surface, so no outcome writes a failure here.
 */
export function useBriefingEnableFlow() {
  const { t, i18n } = useTranslation();
  const { feedback: enabling, begin } = useSurfaceFeedback<EnableSurfaceFailure>();
  // One admission guard covers the switch and the primary button: both start
  // the same confirm-and-enable flow, so a tap on either while one runs does
  // nothing.
  const pending = enabling.status === 'pending';

  const run = async (
    attempt: SurfaceAttempt<EnableSurfaceFailure>,
    epoch: number,
    input: BriefingEnableFlowInput
  ): Promise<void> => {
    if (!input.valid) {
      toast.error(t('agentBriefing.invalidSafeguards'));
      attempt.abandon();
      return;
    }
    const result = await input.refetch();
    // The refetch was slow and the card went away, a newer attempt owns the
    // flow, or the account changed: the dialog and the paid enable must not
    // outlive the attempt that was admitted.
    if (!attempt.owns() || !isCurrentAuthEpoch(epoch)) {
      return;
    }
    // React Native drops an alert presented while no activity is attached, and
    // no callback runs, so the attempt would stay pending with no way out. The
    // person can tap again once the app is in front.
    if (AppState.currentState !== 'active') {
      attempt.abandon();
      return;
    }
    const confirmed = result.data;
    if (!confirmed?.canGenerate) {
      toast.error(t(briefingEstimateUnavailableKey(confirmed?.unavailableReason)));
      attempt.abandon();
      return;
    }
    Alert.alert(
      t('agentBriefing.confirmPaid', { context: input.contextName }),
      t('agentBriefing.paidDisclosure', {
        estimate: briefingMoney(confirmed.estimatedCostMicrodollars, i18n.language),
        maximum: briefingMoney(confirmed.maximumCostMicrodollars, i18n.language),
        minutes: formatNumber(
          confirmed.maxDurationSeconds / 60,
          input.locale,
          SAFEGUARD_DISCLOSURE_FORMAT
        ),
      }),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          // Back, or an outside tap, dismisses the dialog and equals Cancel:
          // nothing is enabled. That dismissal runs no button handler, so the
          // dialog options below settle it.
          onPress: () => {
            attempt.abandon();
          },
        },
        {
          text: t('agentBriefing.enable'),
          onPress: () => {
            // The dialog outlived the flow's own frames, so the press re-checks
            // ownership and the account before the paid write can fire for a
            // card that is gone, superseded, or now belongs to another account.
            if (!attempt.owns() || !isCurrentAuthEpoch(epoch)) {
              return;
            }
            input.confirm(confirmed.estimateToken);
            attempt.abandon();
          },
        },
      ],
      {
        cancelable: true,
        // Android back or an outside tap dismisses the dialog without running a
        // button handler, so the dismissal settles the attempt here; `abandon`
        // is idempotent, so a button press that already settled is unaffected.
        onDismiss: () => {
          attempt.abandon();
        },
      }
    );
  };

  /**
   * Admission before the first await; a tap while one is running does nothing.
   */
  const start = (input: BriefingEnableFlowInput): void => {
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    void run(attempt, currentAuthEpoch(), input);
  };

  return { pending, start };
}
