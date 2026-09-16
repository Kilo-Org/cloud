package com.kilocode.activeagentsliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

/**
 * Starts the headless approve task when the ongoing notification's Approve
 * action is tapped.
 *
 * Not exported: the action's PendingIntent is this app's own, so no other app
 * has to reach the receiver, and a locked phone needs no Activity to answer.
 */
class ActiveAgentsApproveReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    // The service starts asynchronously; hold the device awake until it owns
    // the task, then the service releases the lock when the task finishes.
    HeadlessJsTaskService.acquireWakeLockNow(context)
    context.startService(Intent(context, ActiveAgentsApproveTaskService::class.java))
  }
}
