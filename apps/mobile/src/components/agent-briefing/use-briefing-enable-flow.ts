import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { type BriefingEstimate } from '@kilocode/app-shared/agent-briefing';

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
 * `abandon()` before the dialog, and — because `Alert.alert` is not awaited
 * and the dialog outlives this async function — the cancel/back path and the
 * confirmed enable settle it inside their own handlers. The paid enable only
 * runs after `owns()` says this attempt still owns the card, so a slow refetch
 * whose card unmounted (the store's `invalidateAll` on unmount) or a
 * superseded attempt cannot present a dialog or fire the paid write. Nothing
 * persists on the surface, so no outcome writes a failure here.
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
    input: BriefingEnableFlowInput
  ): Promise<void> => {
    if (!input.valid) {
      toast.error(t('agentBriefing.invalidSafeguards'));
      attempt.abandon();
      return;
    }
    const result = await input.refetch();
    // The refetch was slow and the card went away (or a newer attempt owns
    // the flow): the dialog and the paid enable must not outlive the attempt.
    if (!attempt.owns()) {
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
          // Android back dismisses, which equals Cancel: nothing is enabled.
          onPress: () => {
            attempt.abandon();
          },
        },
        {
          text: t('agentBriefing.enable'),
          onPress: () => {
            // The dialog outlived the flow's own frames, so the press
            // re-checks ownership before the paid write can fire for a card
            // that is gone or superseded.
            if (!attempt.owns()) {
              return;
            }
            input.confirm(confirmed.estimateToken);
            attempt.abandon();
          },
        },
      ],
      { cancelable: true }
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
    void run(attempt, input);
  };

  return { pending, start };
}
