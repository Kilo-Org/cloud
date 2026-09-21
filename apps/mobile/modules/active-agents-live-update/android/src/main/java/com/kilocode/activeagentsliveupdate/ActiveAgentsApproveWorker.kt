package com.kilocode.activeagentsliveupdate

import android.content.Context
import android.os.Handler
import android.os.Looper
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
 * Android-only by capability, not by a product scope: running this app's JS with
 * no process at all — which is what an app-closed Approve needs — is what
 * `WorkManager` plus `HeadlessJsTaskContext` provide, and iOS has no equivalent.
 * An iOS Live Activity button performs an App Intent inside the app's process
 * instead (`expo-widgets` `LiveActivityUserInteraction`, routed by
 * `src/glanceable-ios/interaction.ts`), where the JS the approval needs is
 * already up, so Apple's side keeps no transport to share with this file. Both
 * platforms answer through the same `runGlanceableApprove`
 * (`src/lib/glanceable/approve-ask.ts`) and draw the same Approve control and
 * retry line; only the app-closed transport is platform-specific.
 *
 * This mirrors `oss/HeadlessJsTaskWorker.java` from react-native-android-widget
 * (MIT, Copyright (c) 2022 Jay Kim): start the shared ReactHost, wait for the
 * ReactContext, then run one HeadlessJsTask and complete the worker from the
 * task-finished listener. That library base class is not extended: it is
 * Android-only the same way, and it still holds the pending listener after a
 * stop and matches a finish against the default `taskId` of `0`, the two bugs
 * this worker fixes. WorkManager owns the wake-up; a `HeadlessJsTaskService`
 * is deliberately not used because a background `startService` is restricted on
 * Android 8+. A force-stopped app is out of scope: Android removes the
 * notification and blocks its receiver, so there is nothing to tap.
 */
class ActiveAgentsApproveWorker(context: Context, params: WorkerParameters) :
  ListenableWorker(context, params), HeadlessJsTaskEventListener {

  /** No task started by this worker yet; `HeadlessJsTaskContext` numbers from 1. */
  private var taskId = NO_TASK_ID

  /** Resolved from the task listener, a stop, or the ReactContext timeout. */
  @Volatile private var completer: CallbackToFutureAdapter.Completer<Result>? = null

  /** Set on stop, which can land on another thread than the task start hop. */
  @Volatile private var stopped = false

  /**
   * The host a pending ReactContext listener is attached to, held so a stop can
   * detach it. The ReactHost is shared and outlives this worker, so leaving the
   * listener registered would keep a dead work order listening on it.
   */
  private var pendingReactHost: ReactHost? = null
  private var pendingListener: ReactInstanceEventListener? = null

  /**
   * Bound on the wait for the ReactContext. The shared host can be already
   * running without ever delivering another init event, or a start can stall;
   * with no bound this worker's future would never resolve, WorkManager would
   * keep `UNIQUE_WORK_NAME` in flight, and `ExistingWorkPolicy.KEEP` would then
   * drop every later Approve tap. Runs on the main thread, like the listener
   * registration it guards.
   */
  private val mainHandler = Handler(Looper.getMainLooper())
  private val reactHostTimeout = Runnable { onReactHostTimeout() }

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
      val listener =
        object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            detachReactInstanceListener()
            invokeStartTask(context)
          }
        }
      // Registration and the timeout are set up together on the main thread, so
      // no interleaving can leave the listener live without its bound. The
      // timeout precedes the registration on purpose: a host that never delivers
      // onReactContextInitialized must not hold the unique work name forever.
      UiThreadUtil.runOnUiThread {
        if (stopped || completer == null) {
          return@runOnUiThread
        }
        pendingReactHost = reactHost
        pendingListener = listener
        mainHandler.postDelayed(reactHostTimeout, REACT_HOST_TIMEOUT_MS)
        reactHost.addReactInstanceEventListener(listener)
        val initialized = reactHost.currentReactContext
        if (initialized == null) {
          reactHost.start()
        } else {
          // The context came up between the worker-thread read and this
          // registration, so no init event will be delivered to the listener.
          // Detach it and start from the context that is already here.
          detachReactInstanceListener()
          invokeStartTask(initialized)
        }
      }
    } else {
      invokeStartTask(reactContext)
    }
  }

  /**
   * The ReactContext never arrived. Detach the pending listener so the shared
   * host keeps no callback for a dead work order, then fail the future: that
   * resolves the worker, releases `UNIQUE_WORK_NAME`, and lets the next Approve
   * tap enqueue again.
   */
  private fun onReactHostTimeout() {
    if (stopped || completer == null) {
      return
    }
    detachReactInstanceListener()
    completer?.set(Result.failure())
    completer = null
    cleanUpTask()
  }

  /** Detach the listener still waiting for the ReactContext, exactly once. */
  private fun detachReactInstanceListener() {
    mainHandler.removeCallbacks(reactHostTimeout)
    val host = pendingReactHost ?: return
    val listener = pendingListener ?: return
    pendingReactHost = null
    pendingListener = null
    host.removeReactInstanceEventListener(listener)
  }

  private fun invokeStartTask(reactContext: ReactContext) {
    // A stop can land after the listener was detached but before this call runs:
    // starting JS for a stopped worker would answer nothing. A worker whose
    // future was already resolved — by the timeout or a stop — must not start a
    // task either: nothing would ever complete it.
    if (stopped || completer == null) {
      return
    }
    val taskContext = HeadlessJsTaskContext.getInstance(reactContext)
    val data = Arguments.makeNativeMap(inputData.keyValueMap)
    // startTask must run on the UI thread, like every other Activity/Task hop.
    UiThreadUtil.runOnUiThread {
      // The guard above runs on the worker's thread; WorkManager stops the worker
      // on the main thread, so a stop (or the ReactContext timeout) can land
      // between that check and this hop. Re-checking here is what keeps a late
      // stop from starting JS anyway, and a resolved future from starting a task
      // nothing would complete.
      if (stopped || completer == null) {
        return@runOnUiThread
      }
      // Registering here, after the re-check, is what keeps the listener from
      // being left on the shared HeadlessJsTaskContext: on this thread the stop
      // cannot land between the check and the registration, so either the stop
      // won and nothing was registered, or the registration stands and
      // onStopped's cleanUpTask removes it. Registered on the worker's thread
      // instead, a stop in that window found nothing to remove, and the guard
      // above then returned without ever detaching it. It has to precede
      // startTask: a finish is delivered only to the listeners registered when
      // it lands.
      taskContext.addTaskEventListener(this)
      taskId = taskContext.startTask(HeadlessJsTaskConfig(TASK_NAME, data, TASK_TIMEOUT_MS, true))
    }
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    // Only the id this worker started counts. Before that assignment the
    // sentinel must not match a finish event belonging to another task.
    if (this.taskId != NO_TASK_ID && this.taskId == taskId) {
      completer?.set(Result.success())
      completer = null
      cleanUpTask()
    }
  }

  override fun onStopped() {
    super.onStopped()
    stopped = true
    detachReactInstanceListener()
    // A stop can land before the ReactContext is up, or before the task
    // finishes: the future has to resolve, or WorkManager keeps the work order
    // pending on a worker that will never complete.
    completer?.set(Result.failure())
    completer = null
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

    /**
     * Bound on the wait for the shared ReactHost to hand over a ReactContext.
     * On expiry the worker fails and `UNIQUE_WORK_NAME` is released, so a host
     * that never delivers the init event cannot suppress later Approve taps.
     */
    const val REACT_HOST_TIMEOUT_MS = 60_000L

    /** No task started yet; every id `HeadlessJsTaskContext` returns is positive. */
    private const val NO_TASK_ID = -1

    private const val TAG = "ActiveAgentsApproveWorker.startWork"
  }
}
