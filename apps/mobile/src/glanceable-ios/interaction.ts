// `expo-widgets` is iOS-only by capability (WidgetKit/ActivityKit); the type is
// the press envelope the Live Activity's Approve arrives in.
import { type UserInteractionEvent } from 'expo-widgets';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { applyStoredLanguage } from '@/lib/glanceable/apply-stored-language';
import { type GlanceableApproveResult, runGlanceableApprove } from '@/lib/glanceable/approve-ask';
import { restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { republishAnsweredAsk } from '@/lib/glanceable/republish-ask';
import { readWaitingAsk, recordWaitingAsk } from '@/lib/glanceable/waiting-ask';

import { ActiveAgentsLiveActivity, LIVE_ACTIVITY_NAME } from './active-agents-live-activity';
import {
  renderStoredSnapshotWithNotice,
  setGlanceableActionApproving,
  setGlanceableActionNotice,
} from './ios-sink';

/**
 * What a button press on the Live Activity does.
 *
 * The press arrives as an in-process event: expo-widgets' `LiveActivityIntent`
 * performs in the app's process and posts to `NotificationCenter`
 * (`ios/Widgets/WidgetsEvents.swift`), and the app's subscription forwards it to
 * `handleGlanceableInteraction`. Approve answers the ask without the app, through
 * the same `runGlanceableApprove` body the in-app control uses, so the surface
 * and the app cannot disagree. The card's body opens the agents list on its own
 * deep link; the card has no other control.
 */

/** The Approve target the layout's button carries. */
export const GLANCEABLE_APPROVE_TARGET = 'approve';

/** The one failure line the toast carries; the card keeps its Approve tap. */
const APPROVE_FAILED_KEY = 'glanceable.approveFailed';

/** What the caller — and the test — gets back from one press. */
export type GlanceableInteractionOutcome =
  /** A press from another surface: never answered here. */
  | { kind: 'ignored' }
  /** A press from this surface carrying a target no button declares. */
  | { kind: 'unhandled' }
  | GlanceableApproveResult;

/**
 * Whether the press came from this app's Active Agents Live Activity.
 *
 * A Live Activity's dynamic content is rendered with the ActivityKit activity
 * id as its node name (`ios/Widgets/WidgetLiveActivity.swift` passes
 * `context.activityID`), so a press from this card reports that id as its
 * source, while a home-screen widget reports its widget name. A press belongs
 * to this surface when it names one of this activity's instances; the
 * registered name is accepted as well so a widget-style source cannot be
 * mistaken for a foreign one. Any other source is another layout's press.
 *
 * Ended instances count: `getInstances()` omits them by default, but a terminal
 * card stays on screen until ActivityKit dismisses it, and a press from it is a
 * press on a control the user can see and must route like any other rather
 * than drop. `includeEnded` still excludes dismissed cards, which no press can
 * come from.
 */
function isActiveAgentsLiveActivity(source: string): boolean {
  if (source === LIVE_ACTIVITY_NAME) {
    return true;
  }
  try {
    return ActiveAgentsLiveActivity.getInstances(true).some(
      instance => instance.getId() === source
    );
  } catch {
    // An unreadable or unsupported surface is not an identity: dropping the
    // press beats answering a target that may belong to another layout.
    return false;
  }
}

/**
 * Answer through the shared flow. `runGlanceableApprove` classifies its own
 * failures; anything that still escapes is a failure the user can retry, never
 * a missing answer.
 */
async function approveResult(): Promise<GlanceableApproveResult> {
  try {
    return await runGlanceableApprove({ now: () => Date.now() });
  } catch {
    return { kind: 'retryable' };
  }
}

/**
 * Put the retryable failure line on the card, the surface the press came from.
 * A background press has no app on screen, so the toast below cannot be the
 * only feedback: the notice rides the next Live Activity update, exactly as the
 * Android notification carries it. Best effort — the toast and the recorded ask
 * still stand when the card cannot be updated.
 */
async function showApproveFailed(): Promise<void> {
  setGlanceableActionNotice(i18n.t(APPROVE_FAILED_KEY));
  try {
    await renderStoredSnapshotWithNotice();
  } catch {
    // The next publish corrects the surface; the card keeps its actions.
  }
}

/**
 * Show the press on the card: Approve becomes a muted Approving… pill, and the
 * card hides an earlier failure line while the retry it asked for runs.
 * Best effort — the answer below still runs when the card cannot be updated.
 */
async function showApproving(): Promise<void> {
  setGlanceableActionApproving(true);
  try {
    await renderStoredSnapshotWithNotice();
  } catch {
    // The answer still runs; the flag is cleared and re-rendered after it.
  }
}

/**
 * Answer the recorded ask through the shared flow and drop the action once it
 * is answered. The record is captured before the flow runs, because a
 * successful answer clears it and its ids are what the republish below needs.
 */
async function approveFromCard(): Promise<GlanceableInteractionOutcome> {
  // A press can launch this process in the background with no mounted app root,
  // so nothing else has applied the stored language yet — the same wait the
  // Android headless task performs before it translates. Every line this press
  // produces is translated below: the toast, the card's failure notice, and the
  // widget props the republish renders. Switching i18n first is what keeps them
  // in the user's language instead of English.
  await applyStoredLanguage();
  // The same background launch leaves the persisted glanceable unrestored, and
  // the mirrored ask's cross-scope fence compares against the scope key that
  // restore fills: reading the ask first would accept a record left by a
  // signed-out account or another organization and answer it.
  await restorePersistedGlanceable();
  const ask = await readWaitingAsk();
  await showApproving();
  let failureShown = false;
  try {
    const result = await approveResult();
    // The answer is in: the published states below no longer carry the pill.
    setGlanceableActionApproving(false);
    if (result.kind === 'retryable') {
      // The record stays, so the card keeps Approve for another tap. The toast
      // only reaches the user with the app up, so the card itself carries the
      // failure line as well.
      toast.error(i18n.t(APPROVE_FAILED_KEY));
      failureShown = true;
      await showApproveFailed();
      return result;
    }
    if (result.kind === 'gone') {
      // Answered elsewhere or no longer pending: dropping the record drops the
      // tap, the same way the Android headless task drops it.
      recordWaitingAsk(null);
    }
    if (ask !== null) {
      // The republish skips that session's stale tray row only for an ended
      // ask; a `none` outcome leaves the ask as it is, so re-selecting it
      // keeps the session the card names.
      await republishAnsweredAsk(ask, result.kind === 'approved' || result.kind === 'gone');
    }
    return result;
  } finally {
    // Every outcome — answered, gone, nothing to answer, failed, or a throw —
    // ends the in-flight pill. The republish publishes only a changed snapshot,
    // so the card is re-rendered here to drop the pill either way; a failure
    // already re-rendered with its line.
    setGlanceableActionApproving(false);
    if (!failureShown) {
      try {
        await renderStoredSnapshotWithNotice();
      } catch {
        // The next publish corrects the surface.
      }
    }
  }
}

/** Route one button press from the Live Activity. */
export async function handleGlanceableInteraction(
  event: UserInteractionEvent
): Promise<GlanceableInteractionOutcome> {
  if (!isActiveAgentsLiveActivity(event.source)) {
    return { kind: 'ignored' };
  }
  try {
    if (event.target === GLANCEABLE_APPROVE_TARGET) {
      return await approveFromCard();
    }
  } catch {
    // An escaping throw is a failed press, not a crash: the card keeps its
    // Approve, and the tap that failed is the tap the user can repeat.
    return { kind: 'retryable' };
  }
  return { kind: 'unhandled' };
}
