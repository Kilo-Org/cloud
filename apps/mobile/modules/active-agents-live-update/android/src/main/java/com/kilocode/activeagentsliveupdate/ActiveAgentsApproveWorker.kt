package com.kilocode.activeagentsliveupdate

import android.content.Context
import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.work.ListenableWorker
import androidx.work.WorkerParameters
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import com.google.common.util.concurrent.ListenableFuture

/**
 * Boots headless JS for the notification's Approve tap, with the app closed and
 * no Activity.
 *
 * This mirrors `oss/HeadlessJsTaskWorker.java` from react-native-android-widget
 * (MIT, Copyright (c) 2022 Jay Kim): start the shared ReactHost, wait for the
 * ReactContext, then run one HeadlessJsTask and complete the worker from the
 * task-finished listener. WorkManager owns the wake-up; a `HeadlessJsTaskService`
 * is deliberately not used because a background `startService` is restricted on
 * Android 8+. A force-stopped app is out of scope: Android removes the
 * notification and blocks its receiver, so there is nothing to tap.
 */
class ActiveAgentsApproveWorker(context: Context, params: WorkerParameters) :
  ListenableWorker(context, params), HeadlessJsTaskEventListener {

  private var taskId = 0
  private var completer: CallbackToFutureAdapter.Completer<Result>? = null

  override fun startWork(): ListenableFuture<Result> =
    CallbackToFutureAdapter.getFuture(
      CallbackToFutureAdapter.Resolver<Result> { completer ->
        this.completer = completer
        val reactHost = (applicationContext as? ReactApplication)?.reactHost
        if (reactHost == null) {
          completer.set(Result.failure())
        } else {
          startTask(reactHost)
        }
        TAG
      }
    )

  private fun startTask(reactHost: ReactHost) {
    val reactContext = reactHost.currentReactContext
    if (reactContext == null) {
      reactHost.addReactInstanceEventListener(object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          invokeStartTask(context)
          reactHost.removeReactInstanceEventListener(this)
        }
      })
      reactHost.start()
    } else {
      invokeStartTask(reactContext)
    }
  }

  private fun invokeStartTask(reactContext: ReactContext) {
    val taskContext = HeadlessJsTaskContext.getInstance(reactContext)
    taskContext.addTaskEventListener(this)
    val data = Arguments.makeNativeMap(inputData.keyValueMap)
    // startTask must run on the UI thread, like every other Activity/Task hop.
    UiThreadUtil.runOnUiThread {
      taskId = taskContext.startTask(HeadlessJsTaskConfig(TASK_NAME, data, TASK_TIMEOUT_MS, true))
    }
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    if (this.taskId == taskId) {
      completer?.set(Result.success())
      completer = null
      cleanUpTask()
    }
  }

  override fun onStopped() {
    super.onStopped()
    cleanUpTask()
  }

  private fun cleanUpTask() {
    val reactContext =
      (applicationContext as? ReactApplication)?.reactHost?.currentReactContext ?: return
    HeadlessJsTaskContext.getInstance(reactContext).removeTaskEventListener(this)
  }

  companion object {
    /** Unique work name: one pending answer, so a double tap cannot double-answer. */
    const val UNIQUE_WORK_NAME = "active-agents-approve"

    /** Input key carrying the action the receiver enqueued. */
    const val KEY_ACTION = "action"

    /**
     * Headless task key the JS entrypoint registers with `AppRegistry` (the
     * constant s5 owns; keep the two names in step).
     */
    const val TASK_NAME = "KiloActiveAgentsApprove"

    /** Bounded: an answer that cannot complete must not hold the worker. */
    const val TASK_TIMEOUT_MS = 60_000L

    private const val TAG = "ActiveAgentsApproveWorker.startWork"
  }
}
