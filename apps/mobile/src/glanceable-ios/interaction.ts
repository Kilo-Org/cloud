import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';
// `expo-widgets` is iOS-only by capability (WidgetKit/ActivityKit); the type is
// the one press envelope both Live Activity targets arrive in.
import { type UserInteractionEvent } from 'expo-widgets';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { applyStoredLanguage } from '@/lib/glanceable/apply-stored-language';
import { type GlanceableApproveResult, runGlanceableApprove } from '@/lib/glanceable/approve-ask';
import { restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { republishAnsweredAsk } from '@/lib/glanceable/republish-ask';
import { readWaitingAsk, recordWaitingAsk } from '@/lib/glanceable/waiting-ask';
import { setPendingDeepLink } from '@/lib/deep-link-launch';
import { launcherSessionUrl } from '@/lib/launcher-surfaces';

import {
  ActiveAgentsLiveActivity,
  LIVE_ACTIVITY_NAME,
  OPEN_AGENTS_URL,
} from './active-agents-live-activity';
import { renderStoredSnapshotWithNotice, setGlanceableActionNotice } from './ios-sink';

/**
 * What a button press on the Live Activity does.
 *
 * The press arrives as an in-process event: expo-widgets' `LiveActivityIntent`
 * performs in the app's process and posts to `NotificationCenter`
 * (`ios/Widgets/WidgetsEvents.swift`), and the app's subscription forwards it to
 * `handleGlanceableInteraction`. Approve keeps that background path — it answers
 * the ask without the app. Open would perform there unseen, so its button asks
 * for the foreground instead (`openAppWhenRun`, read by the patched expo-widgets
 * button view) and the destination it stashes is consumed with the app up. The
 * answer and the navigation are the same bodies the in-app control uses —
 * `runGlanceableApprove` for Approve, `resolveIncomingUrl` + the
 * pending-deep-link slot for Open — so the surface and the app cannot disagree
 * about either.
 */

/** The Approve target the layout's button carries. */
export const GLANCEABLE_APPROVE_TARGET = 'approve';
/** The Open target the layout's button carries. */
export const GLANCEABLE_OPEN_TARGET = 'open';

/** The one failure line the toast carries; the card keeps its Approve tap. */
const APPROVE_FAILED_KEY = 'glanceable.approveFailed';

/** What the caller — and the test — gets back from one press. */
export type GlanceableInteractionOutcome =
  /** A press from another surface: never answered here. */
  | { kind: 'ignored' }
  /** A press from this surface carrying a target no button declares. */
  | { kind: 'unhandled' }
  /** Open landed on the recorded session, or on the Agents tab when none was recorded. */
  | { kind: 'opened'; href: string }
  /** Open whose target the app's router could not resolve; nothing was stashed. */
  | { kind: 'no_session' }
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
 * card stays on screen until ActivityKit dismisses it, and this layout draws
 * Open on it for that whole window, so a press from it is a press on a control
 * the user can see and must route like any other rather than drop. `includeEnded`
 * still excludes dismissed cards, which no press can come from.
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
  const result = await approveResult();
  if (result.kind === 'retryable') {
    // The record stays, so the card keeps Approve for another tap. The toast
    // only reaches the user with the app up, so the card itself carries the
    // failure line as well.
    toast.error(i18n.t(APPROVE_FAILED_KEY));
    await showApproveFailed();
    return result;
  }
  if (result.kind === 'gone') {
    // Answered elsewhere or no longer pending: dropping the record drops the
    // tap, the same way the Android headless task drops it.
    recordWaitingAsk(null);
  }
  if (ask !== null) {
    // The republish skips that session's stale tray row only for an ended ask; a
    // `none` outcome leaves the ask as it is, so re-selecting it keeps the
    // session Open names.
    await republishAnsweredAsk(ask, result.kind === 'approved' || result.kind === 'gone');
  }
  return result;
}

/**
 * Land on the recorded waiting session through the app's own deep-link path.
 * The id is the only thing kept beside the privacy-minimal snapshot, and it
 * goes into the URL and nowhere else. The hydrated read is the same one the
 * headless paths use: a press that launched the process in the background has
 * no in-memory record yet, only the mirrored one.
 *
 * With nothing recorded there is no session to open, and the button itself
 * carries no URL — so Open falls back to the Agents tab, the destination the
 * card's body deep-links to and the one Android's notification already uses.
 * A press that stashes nothing would be the dead control this button must not
 * be; guessing a session stays the one thing it must not do.
 */
async function openRecordedSession(): Promise<GlanceableInteractionOutcome> {
  // The same stored scope as the Approve press: the persisted glanceable is
  // what the mirrored ask is fenced against, and this press can arrive before
  // the app root restores it.
  await restorePersistedGlanceable();
  const ask = await readWaitingAsk();
  const href = resolveIncomingUrl(
    ask === null ? OPEN_AGENTS_URL : launcherSessionUrl(ask.kiloSessionId)
  );
  if (href === null) {
    return { kind: 'no_session' };
  }
  setPendingDeepLink(href, 'universal-link');
  return { kind: 'opened', href };
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
    if (event.target === GLANCEABLE_OPEN_TARGET) {
      return await openRecordedSession();
    }
  } catch {
    // An escaping throw is a failed press, not a crash: the card keeps both
    // buttons, and the tap that failed is the tap the user can repeat.
    return { kind: 'retryable' };
  }
  return { kind: 'unhandled' };
}
