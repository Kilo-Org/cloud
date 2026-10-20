package com.kilocode.activeagentsliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager

/**
 * Answers a session notification's dismissal and quiet alarm, without an
 * Activity, and an Approve action from a card posted by an older build.
 *
 * Approve from the current cards goes through `ActiveAgentsApprovalActivity`,
 * which starts the headless approval once the device is unlocked
 * (`ApprovalGate`). The branch below answers an older card's action under the
 * same unlocked-device requirement.
 *
 * The receiver only enqueues and returns: a broadcast has a short budget, and a
 * background `startService` is restricted on Android 8+, so the answer runs as
 * headless JS in a unique OneTimeWorkRequest. `KEEP` means a double tap while
 * one answer is in flight enqueues nothing, so the same ask cannot be answered
 * twice. A force-stopped app has no notification to tap, so there is nothing to
 * handle there.
 *
 * Android-only by capability: an iOS Live Activity press performs inside the
 * app's process through `expo-widgets` (`src/glanceable-ios/interaction.ts`) and
 * needs no broadcast. Both then answer through the same JS body,
 * `src/lib/glanceable/approve-ask.ts`.
 */
class ActiveAgentsActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action != ACTION_APPROVE && action != ACTION_DISMISS && action != ACTION_QUIET) {
      return
    }
    val sessionId = intent.getStringExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID)
    if (action == ACTION_QUIET) {
      // The card itself changes, so no JS runs: the stored card has the quiet form.
      if (sessionId != null) {
        SessionNotifications.postQuiet(context, sessionId, intent.getLongExtra(EXTRA_QUIET_AT, 0))
      }
      return
    }
    if (action == ACTION_DISMISS) {
      if (sessionId == null) {
        return
      }
      // A dismissal is an Unfollow (spec "Android: actions" rule 4). Drop the
      // stored card now, so no later update re-posts it; then the headless JS
      // stops following the session and deletes its server row. Each session
      // has its own unique work: a clear-all dismisses several cards at once,
      // and one shared name would let `KEEP` drop all but the first.
      SessionNotifications.cancel(context, sessionId)
      enqueueDismiss(context, sessionId)
      return
    }
    if (ApprovalGate.isDeviceLocked(context)) {
      return
    }
    ApprovalGate.enqueue(context, intent)
  }

  /** Stop following one dismissed session, as headless JS. */
  private fun enqueueDismiss(context: Context, sessionId: String) {
    val request = OneTimeWorkRequest.Builder(ActiveAgentsApproveWorker::class.java)
      .setInputData(
        Data.Builder()
          .putString(ActiveAgentsApproveWorker.KEY_ACTION, ACTION_DISMISS)
          .putString(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId)
          .build()
      )
      .build()
    WorkManager.getInstance(context)
      .enqueueUniqueWork("$DISMISS_WORK_PREFIX$sessionId", ExistingWorkPolicy.KEEP, request)
  }

  companion object {
    /** The Approve action a card posted by an older build carries. */
    const val ACTION_APPROVE = "com.kilocode.activeagentsliveupdate.action.APPROVE"

    /**
     * The user dismissed a session notification (a swipe or a clear-all). The
     * card is gone either way, so the app stops following that session.
     */
    const val ACTION_DISMISS = "com.kilocode.activeagentsliveupdate.action.DISMISS"

    /** A Working session card reached its quiet moment; see `SessionNotifications.postQuiet`. */
    const val ACTION_QUIET = "com.kilocode.activeagentsliveupdate.action.QUIET"

    /** The quiet moment the alarm was armed for, in epoch milliseconds. */
    const val EXTRA_QUIET_AT = "quiet_at"

    /** Unique work per dismissed session; see `enqueueDismiss`. */
    private const val DISMISS_WORK_PREFIX = "active-agents-dismiss:"
  }
}
