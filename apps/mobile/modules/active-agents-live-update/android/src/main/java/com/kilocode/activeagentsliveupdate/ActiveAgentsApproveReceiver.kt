package com.kilocode.activeagentsliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService

/**
 * The headless approve transport that an older build's Approve action reaches.
 *
 * Current cards approve through `ApprovalGate`, which sends the tap to
 * `ActiveAgentsApprovalActivity` and starts the approval from there; no source
 * in this module mints an Intent or PendingIntent naming this receiver. The pair
 * stays because a PendingIntent an older build minted survives the update: a
 * card that build posted can still be tapped, and its Approve must answer as it
 * did then.
 *
 * Not exported: the action's PendingIntent is this app's own, so no other app
 * has to reach the receiver, and a locked phone needs no Activity to answer.
 */
class ActiveAgentsApproveReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try {
      context.startService(Intent(context, ActiveAgentsApproveTaskService::class.java))
    } catch (error: IllegalStateException) {
      // API 26+ background service limits can refuse the start. The wrist
      // surface has no error state, so the refusal is logged and the card keeps
      // its Approve control: tapping again retries.
      Log.w(TAG, "The headless approve task could not be started", error)
      return
    }
    // Only once the service is on its way. The task service acquires its own
    // lock in `startTask` and releases it when the task finishes, so a start
    // that was refused must not leave a lock nothing can release.
    HeadlessJsTaskService.acquireWakeLockNow(context)
  }

  private companion object {
    const val TAG = "ActiveAgentsApprove"
  }
}
