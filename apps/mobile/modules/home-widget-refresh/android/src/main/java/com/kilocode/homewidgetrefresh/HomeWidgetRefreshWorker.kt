package com.kilocode.homewidgetrefresh

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** WorkManager performs networking before booting JS; JS is only the widget renderer. */
class HomeWidgetRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  @Volatile private var stopped = false
  private val finished = CountDownLatch(1)
  private var listener: ReactInstanceEventListener? = null
  private var taskContext: HeadlessJsTaskContext? = null
  private var taskListener: HeadlessJsTaskEventListener? = null
  private var taskId = -1

  override fun doWork(): Result {
    try {
      val payload = try { HomeWidgetStore.fetch(applicationContext) } catch (_: Exception) { null }
      if (payload != null && !isStopped) render(payload)
      return Result.success()
    } finally {
      cleanup()
      if (!isStopped) HomeWidgetStore.schedule(applicationContext)
    }
  }

  private fun render(payload: JSONObject) {
    val host = (applicationContext as? ReactApplication)?.reactHost ?: return
    UiThreadUtil.runOnUiThread {
      if (stopped) return@runOnUiThread
      val ready = host.currentReactContext
      if (ready != null) startTask(ready, payload) else {
        val pending = object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            listener?.let { host.removeReactInstanceEventListener(it) }
            listener = null
            startTask(context, payload)
          }
        }
        listener = pending
        host.addReactInstanceEventListener(pending)
        val initialized = host.currentReactContext
        if (initialized != null) {
          host.removeReactInstanceEventListener(pending)
          listener = null
          startTask(initialized, payload)
        } else host.start()
      }
    }
    finished.await(60, TimeUnit.SECONDS)
  }

  private fun startTask(context: ReactContext, payload: JSONObject) {
    if (stopped || !HomeWidgetStore.current(applicationContext, payload.getString("scopeKey"), payload.getInt("accountEpoch"), payload.getString("generation"))) {
      finished.countDown()
      return
    }
    val tasks = HeadlessJsTaskContext.getInstance(context)
    val events = object : HeadlessJsTaskEventListener {
      override fun onHeadlessJsTaskStart(id: Int) = Unit
      override fun onHeadlessJsTaskFinish(id: Int) { if (id == taskId) finished.countDown() }
    }
    taskContext = tasks
    taskListener = events
    tasks.addTaskEventListener(events)
    taskId = tasks.startTask(HeadlessJsTaskConfig("HomeWidgetRefresh", Arguments.makeNativeMap(jsonMap(payload)), 45_000, true))
  }

  private fun cleanup() {
    stopped = true
    UiThreadUtil.runOnUiThread {
      val host = (applicationContext as? ReactApplication)?.reactHost
      listener?.let { host?.removeReactInstanceEventListener(it) }
      listener = null
      taskListener?.let { taskContext?.removeTaskEventListener(it) }
      taskListener = null
    }
  }
  override fun onStopped() { super.onStopped(); cleanup(); finished.countDown() }
}
