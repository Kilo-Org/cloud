import { AppRegistry } from 'react-native';

import { i18n } from '@/i18n';
import { applyStoredLanguage } from '@/lib/glanceable/apply-stored-language';
import { runGlanceableApprove } from '@/lib/glanceable/approve-ask';
import { restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { republishAnsweredAsk } from '@/lib/glanceable/republish-ask';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import { readWaitingAsk, recordWaitingAsk, type WaitingAsk } from '@/lib/glanceable/waiting-ask';
import { dismissNeedsInputNotification } from '@/lib/needs-input-notification';

import {
  androidSink,
  renderStoredSnapshotWithNotice,
  setGlanceableActionNotice,
} from './android-sink';

/**
 * The JS bodies the ongoing notification's Approve action runs headless.
 *
 * Two registrations share this module. `handleApproveTask` answers the ask the
 * app recorded, and the entry registers it under `APPROVE_HEADLESS_TASK_KEY`
 * via the Kotlin worker; `runApproveTask` runs the front-approval service and
 * is registered under `APPROVE_AGENT_TASK_KEY` by `registerApproveTask`, the
 * key the `ActiveAgentsApproveTaskService` chain starts. Only the strings cross
 * the native boundary, so they are asserted equal in `approve-task.test.ts`.
 *
 * The recorded waiting ask is the only thing `handleApproveTask` answers —
 * never the snapshot's counts — and it also names the ids the republish below
 * needs.
 */
export const APPROVE_HEADLESS_TASK_KEY = 'KiloActiveAgentsApprove';

/**
 * The key the `ActiveAgentsApproveTaskService` chain starts. One literal,
 * shared by the Kotlin service and this registration: a mismatch would leave
 * that notification action with no task.
 */
export const APPROVE_AGENT_TASK_KEY = 'ActiveAgentsApprove';

/** The approval the task runs. Injected so the flow is unit-testable. */
export type ApproveRunner = () => Promise<void>;

// A headless approve run has no Activity and no app root, so nothing else has
// loaded the Android sink by the time the republish below runs; without the
// registration the new record would reach no surface and the notification would
// keep asking. The registry is a Set, so the foreground path registering the
// same sink again is a no-op.
registerGlanceableSink(androidSink);

/** The failure line the notification carries until the next tap or publish. */
const APPROVE_FAILED_KEY = 'glanceable.approveFailed';

function translate(key: string): string {
  return i18n.t(key);
}

/**
 * Show the retryable failure line: prefix it to the stored snapshot the app last
 * published, so a headless tap that cannot reach the backend still reports the
 * failure the user's tap produced. Awaited, because the render is the only
 * thing that carries the line to the notification and the task may finish right
 * after it; a failed render is dropped — the republish below draws the line
 * again from the same stored counts.
 */
async function showApproveFailed(ask: WaitingAsk): Promise<void> {
  setGlanceableActionNotice(translate(APPROVE_FAILED_KEY));
  try {
    await renderStoredSnapshotWithNotice({
      userId: ask.userId,
      organizationId: ask.organizationId,
    });
  } catch {
    // The republish corrects the surface; the notification keeps its action.
  }
}

/**
 * Answer the recorded ask and update the notification in place. Never throws:
 * the worker completes from the headless task's finish, so a rejection would
 * only lose the failure state the user needs to see. A thrown error is a
 * retryable failure — keep the ask, show the line, leave Approve for another tap.
 *
 * The failure line is drawn twice: before the republish, so the user does not
 * wait out the refresh's poll budget to learn the tap failed, and again after it,
 * because the republish writes the notification and re-selects the ask from the
 * tray — a line drawn only first can be pruned by the render that follows it,
 * and the user would then see the failure nowhere. Both draws are awaited: the
 * task resolves once the last render has reached the notification, so a headless
 * process cannot exit with the update still in flight.
 */
export async function handleApproveTask(): Promise<void> {
  let ask: WaitingAsk | null = null;
  let failed = false;
  // Only an ask the answer ended leaves a stale tray row to skip. A retryable
  // failure (and an unexpected throw) keeps the ask waiting, and the republish
  // has to re-select it so the next tap answers the same session.
  let askEnded = false;
  try {
    // A headless run has no app root, so nothing else applies the stored
    // language — and both the failure line below and the notification the
    // republish renders must be in the user's language, not English.
    await applyStoredLanguage();
    // The ask is fenced on the scope this process publishes, and that scope key
    // is the persisted one on a cold headless process: restore it before the
    // mirrored ask is read, or a record left by a signed-out account or another
    // organization would be answered.
    await restorePersistedGlanceable();
    ask = await readWaitingAsk();
    if (ask === null) {
      // Nothing is recorded, so there is no ask to answer and no action to drop.
      return;
    }
    const result = await runGlanceableApprove({ now: () => Date.now() });
    askEnded = result.kind === 'approved' || result.kind === 'gone';
    if (result.kind === 'gone') {
      // Answered elsewhere or no longer pending: dropping the record drops Approve.
      recordWaitingAsk(null);
    } else if (result.kind === 'retryable') {
      // Keep the record: the notification keeps Approve for another tap.
      failed = true;
    }
  } catch {
    // Keep the recorded ask and its Approve; only the failure line is needed.
    failed = ask !== null;
  }
  if (ask === null) {
    return;
  }
  if (askEnded) {
    // The same raise is presented twice: on this card and on the app-owned
    // needs-input notification, which is a separate carrier with its own
    // Approve action. The mount that re-plans the posted set is not mounted on
    // this headless path, so nothing else takes the answered raise off the
    // shade; awaited, because the headless task ends with this promise.
    await dismissNeedsInputNotification(ask.kiloSessionId);
  }
  if (failed) {
    await showApproveFailed(ask);
  }
  await republishAnsweredAsk(ask, askEnded);
  if (failed) {
    await showApproveFailed(ask);
  }
}

/**
 * Run one approval headless, from the ongoing notification's Approve action.
 *
 * The stored language goes first, for the same reason a widget redraw applies
 * it: the process has no Activity, so nothing else has switched i18n and the
 * surface the approval republishes would render English. Then the same service
 * the phone's permission card backs runs, and it republishes the surfaces
 * before it resolves.
 *
 * A rejection never reaches Android — `AppRegistry.startHeadlessTask` only
 * finishes the native task for a resolved promise, so a rejection would hold
 * the service's wake lock until its timeout. Every failure is swallowed here,
 * and the surface republish inside the service is what shows the user whether
 * the approval landed.
 */
export async function runApproveTask(
  approve: ApproveRunner = loadApproveFrontAgent
): Promise<void> {
  await applyLanguageBestEffort();
  try {
    await approve();
  } catch {
    // Swallowed by design; see the doc comment above.
  }
}

/**
 * The language is copy only: a failure there must not swallow the tap the user
 * made, so it is best-effort and the approval runs in whatever language the
 * process already has.
 */
async function applyLanguageBestEffort(): Promise<void> {
  try {
    // The import does double duty: it registers the Android sink the refreshed
    // surfaces have to reach, and it hands over the one language step a
    // headless process has nothing else to run.
    //
    // Loaded on task fire, not at app entry: the widget register module pulls in
    // the widget sink and an `AppState` listener, which this chain's own task
    // never needs.
    const { applyWidgetLanguage } = await import('./register');
    await applyWidgetLanguage();
  } catch {
    // Swallowed by design; see the doc comment above.
  }
}

/** The wired default: the one s2 approval service both wrists share. */
async function loadApproveFrontAgent(): Promise<void> {
  const { approveFrontAgent } = await import('@/lib/glanceable/approve-front-agent');
  await approveFrontAgent();
}

/** The registered task. Android passes an empty data map, which is ignored. */
async function approveTask(): Promise<void> {
  await runApproveTask();
}

/**
 * Register the headless task for the notification action. Called from the app
 * entry, before `expo-router/entry`: Android can deliver the action to a cold
 * process that never had a widget redraw.
 */
export function registerApproveTask(): void {
  AppRegistry.registerHeadlessTask(APPROVE_AGENT_TASK_KEY, () => approveTask);
}
