package com.kilocode.activeagentsliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager

/**
 * Answers the ongoing notification's Approve action without an Activity.
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
    if (intent.action != ACTION_APPROVE) {
      return
    }
    val request = OneTimeWorkRequest.Builder(ActiveAgentsApproveWorker::class.java)
      .setInputData(
        Data.Builder()
          .putString(ActiveAgentsApproveWorker.KEY_ACTION, ACTION_APPROVE)
          .build()
      )
      .build()
    WorkManager.getInstance(context)
      .enqueueUniqueWork(ActiveAgentsApproveWorker.UNIQUE_WORK_NAME, ExistingWorkPolicy.KEEP, request)
  }

  companion object {
    /** Explicit action on the notification's Approve PendingIntent. */
    const val ACTION_APPROVE = "com.kilocode.activeagentsliveupdate.action.APPROVE"
  }
}
