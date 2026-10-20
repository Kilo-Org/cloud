package com.kilocode.activeagentsliveupdate

import android.app.KeyguardManager
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager

/**
 * The one Approve transport both Android cards share: a tap that starts the
 * headless approval once the device is unlocked.
 *
 * Approve starts the approval, so every surface sends the tap to
 * `ActiveAgentsApprovalActivity` rather than straight to the worker, and the
 * action also carries the platform's authentication requirement where the
 * platform has one (API 31+), so the keyguard appears before the intent is even
 * sent. Dismissal and Open keep their own transports.
 *
 * Android-only by capability: an iOS Live Activity's control performs inside
 * the app's process (`src/glanceable-ios/interaction.ts`), which only runs on an
 * unlocked device in the first place.
 */
internal object ApprovalGate {
  /** The activity intent answering one card's own session, or the recorded ask. */
  fun intent(context: Context, sessionId: String?, approvalKey: String?): Intent {
    val intent = Intent(context, ActiveAgentsApprovalActivity::class.java)
    // A session card answers its own session and the exact request it shows;
    // the aggregate card passes neither, and the headless body reads the
    // recorded ask for that case.
    if (sessionId != null) {
      intent.putExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId)
      intent.putExtra(ActiveAgentsApproveWorker.KEY_APPROVAL_KEY, approvalKey)
    }
    return intent
  }

  /** The Approve action's record. Immutable: only this app builds its extras. */
  fun pendingIntent(
    context: Context,
    requestCode: Int,
    sessionId: String?,
    approvalKey: String?
  ): PendingIntent =
    PendingIntent.getActivity(
      context,
      requestCode,
      intent(context, sessionId, approvalKey),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  /**
   * The Approve action. From API 31 the platform holds the tap until the device
   * is unlocked and shows the keyguard itself; below it the gate activity is
   * what asks, because the action's own authentication flag does not exist.
   */
  fun action(
    context: Context,
    icon: Int,
    label: String,
    pendingIntent: PendingIntent
  ): Notification.Action {
    val builder = Notification.Action.Builder(
      Icon.createWithResource(context, icon),
      label,
      pendingIntent
    )
    if (Build.VERSION.SDK_INT >= 31) {
      builder.setAuthenticationRequired(true)
    }
    return builder.build()
  }

  /** The device is locked behind a credential the user has set. */
  fun isDeviceLocked(context: Context): Boolean =
    (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked

  /**
   * Run one answer as headless JS in a unique work order. `KEEP` means a double
   * tap while one answer is in flight enqueues nothing, so the same ask cannot
   * be answered twice.
   */
  fun enqueue(context: Context, intent: Intent) {
    val request = OneTimeWorkRequest.Builder(ActiveAgentsApproveWorker::class.java)
      .setInputData(
        Data.Builder()
          .putString(
            ActiveAgentsApproveWorker.KEY_ACTION,
            ActiveAgentsActionReceiver.ACTION_APPROVE
          )
          .putString(
            ActiveAgentsApproveWorker.KEY_SESSION_ID,
            intent.getStringExtra(ActiveAgentsApproveWorker.KEY_SESSION_ID)
          )
          .putString(
            ActiveAgentsApproveWorker.KEY_APPROVAL_KEY,
            intent.getStringExtra(ActiveAgentsApproveWorker.KEY_APPROVAL_KEY)
          )
          .build()
      )
      .build()
    WorkManager.getInstance(context)
      .enqueueUniqueWork(
        ActiveAgentsApproveWorker.UNIQUE_WORK_NAME,
        ExistingWorkPolicy.KEEP,
        request
      )
  }
}
