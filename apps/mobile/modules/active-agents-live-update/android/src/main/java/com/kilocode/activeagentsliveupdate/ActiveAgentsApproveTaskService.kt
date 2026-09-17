package com.kilocode.activeagentsliveupdate

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the headless approve task, with no Activity, when the ongoing
 * notification's Approve action is tapped.
 *
 * The config names the key the JS entry registers as `APPROVE_AGENT_TASK_KEY`
 * and passes an empty data map: the approval reads the waiting sessions itself,
 * so nothing about the ask travels through the intent beyond the tap.
 */
class ActiveAgentsApproveTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      TASK_KEY,
      Arguments.createMap(),
      TASK_TIMEOUT_MS,
      // The shade can be pulled over a running app, so the tap can arrive while
      // an Activity is foregrounded. The task is one short, user-initiated call.
      true
    )

  private companion object {
    /** The JS task key. Must stay equal to `APPROVE_AGENT_TASK_KEY`. */
    const val TASK_KEY = "ActiveAgentsApprove"

    /**
     * The approval waits up to 15 s for the ask to replay after attaching, then
     * republishes the surfaces: a minute bounds the whole task without cutting
     * a slow attach short.
     */
    const val TASK_TIMEOUT_MS = 60_000L
  }
}
