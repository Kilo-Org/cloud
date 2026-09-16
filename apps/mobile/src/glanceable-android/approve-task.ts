import { i18n } from '@/i18n';
import { applyStoredLanguage } from '@/lib/glanceable/apply-stored-language';
import { refreshGlanceableSnapshot, runGlanceableApprove } from '@/lib/glanceable/approve-ask';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import { readWaitingAsk, recordWaitingAsk, type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import {
  androidSink,
  renderStoredSnapshotWithNotice,
  setGlanceableActionNotice,
} from './android-sink';

/**
 * The JS body the notification's Approve tap runs.
 *
 * `ActiveAgentsApproveWorker` boots headless JS with no Activity and starts this
 * task, so the entry registers it by this key. The worker's `TASK_NAME` and the
 * entry's registration carry the same string; all three are asserted equal in
 * `approve-task.test.ts`, because only the string crosses the native boundary.
 *
 * The recorded waiting ask is the only thing there is to answer — never the
 * snapshot's counts — and it also names the ids the republish below needs.
 */
export const APPROVE_HEADLESS_TASK_KEY = 'KiloActiveAgentsApprove';

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
 * Republish through the publisher the app mounts, so every registered sink
 * (the Android notification and widget here) reads the current record and the
 * notice. Best effort: a failed refresh must not reject the task, and the record
 * it left behind is still the truth the next tap or publish acts on.
 */
async function republish(ask: WaitingAsk): Promise<void> {
  try {
    await refreshGlanceableSnapshot({
      userId: ask.userId,
      organizationId: ask.organizationId,
      answeredKiloSessionId: ask.kiloSessionId,
    });
  } catch {
    // The next publish corrects the surface; the notification keeps its action.
  }
}

/**
 * Show the retryable failure line: prefix it to the stored snapshot the app last
 * published, so a headless tap that cannot reach the backend still reports the
 * failure the user's tap produced.
 */
function showApproveFailed(ask: WaitingAsk): void {
  setGlanceableActionNotice(translate(APPROVE_FAILED_KEY));
  renderStoredSnapshotWithNotice({
    userId: ask.userId,
    organizationId: ask.organizationId,
  });
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
 * and the user would then see the failure nowhere.
 */
export async function handleApproveTask(): Promise<void> {
  let ask: WaitingAsk | null = null;
  let failed = false;
  try {
    // A headless run has no app root, so nothing else applies the stored
    // language — and both the failure line below and the notification the
    // republish renders must be in the user's language, not English.
    await applyStoredLanguage();
    ask = await readWaitingAsk();
    if (ask === null) {
      // Nothing is recorded, so there is no ask to answer and no action to drop.
      return;
    }
    const result = await runGlanceableApprove({ now: () => Date.now() });
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
  if (failed) {
    showApproveFailed(ask);
  }
  await republish(ask);
  if (failed) {
    showApproveFailed(ask);
  }
}
