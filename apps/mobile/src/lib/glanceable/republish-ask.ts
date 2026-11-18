import { refreshGlanceableSnapshot } from './approve-ask';
import { type WaitingAsk } from './waiting-ask';

/**
 * The republish after an activity action answered the recorded ask.
 *
 * One implementation for both platforms: the Android headless task
 * (`src/glanceable-android/approve-task.ts`) and the iOS Live Activity press
 * (`src/glanceable-ios/interaction.ts`) call this, so the notification and the
 * card can never disagree about what the tray holds. The platforms differ only
 * in the transport that carried the press; the republished state is the same.
 *
 * `askEnded` distinguishes the two outcomes the republish has to tell apart. An
 * ended ask (the answer landed, or the ask was already gone) leaves a stale tray
 * row the refresh skips, while the next waiting session keeps its action. A
 * retryable failure leaves the ask waiting, so the tray's row for it is the
 * truth and the refresh re-selects it: the retry the failure line promises has
 * to answer that same session.
 *
 * Best effort: the record the flow left behind is still the truth the next tap
 * or publish acts on, so a failed refresh must neither reject the task nor drop
 * the surface's action.
 */
export async function republishAnsweredAsk(ask: WaitingAsk, askEnded: boolean): Promise<void> {
  try {
    await refreshGlanceableSnapshot({
      userId: ask.userId,
      organizationId: ask.organizationId,
      answeredKiloSessionId: ask.kiloSessionId,
      askEnded,
    });
  } catch {
    // The next publish corrects the surface; it keeps its action until then.
  }
}
