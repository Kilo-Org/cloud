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
 * Best effort: the record the flow left behind is still the truth the next tap
 * or publish acts on, so a failed refresh must neither reject the task nor drop
 * the surface's action.
 */
export async function republishAnsweredAsk(ask: WaitingAsk): Promise<void> {
  try {
    await refreshGlanceableSnapshot({
      userId: ask.userId,
      organizationId: ask.organizationId,
      answeredKiloSessionId: ask.kiloSessionId,
    });
  } catch {
    // The next publish corrects the surface; it keeps its action until then.
  }
}
