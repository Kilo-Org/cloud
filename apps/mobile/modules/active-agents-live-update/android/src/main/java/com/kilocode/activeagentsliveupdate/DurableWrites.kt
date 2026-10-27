package com.kilocode.activeagentsliveupdate

import android.content.BroadcastReceiver
import android.util.Log
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * Log tag of the active agents surfaces. The Expo module's durable writes and
 * the receivers' card writes report through it, so one `adb logcat -s
 * ActiveAgentsLiveUpdate` shows either.
 */
internal const val ACTIVE_AGENTS_TAG = "ActiveAgentsLiveUpdate"

/**
 * The one home of the durable write path.
 *
 * Every write here persists SharedPreferences (a synchronous fsync), arms or
 * cancels an OS alarm, and posts or cancels a notification. None of it may run
 * on the thread that asked for it: the JavaScript thread for a module call, the
 * broadcast (main) thread for a receiver.
 *
 * The queue is a process-wide singleton rather than a per-caller executor: a
 * receiver has no lifecycle to drain, and `OnDestroy` cannot drain a module's
 * queue either, so a per-instance executor would let a replaced caller's
 * already-queued write land after a newer one and persist a stale snapshot or
 * deadline. One queue keeps every durable write in submission order, and the
 * order matters: `post` writes the card, then reads back the state it just
 * wrote.
 *
 * Neither default Expo queue fits: `Queues.DEFAULT` is a thread pool, so the
 * writes would race each other, and `Queues.MAIN` would put the fsync on the UI
 * thread. A single-thread executor exposed as a dispatcher is what `runOnQueue`
 * accepts for a custom queue.
 *
 * Android's alone, like the SharedPreferences fsync and the `AlarmManager`
 * round-trip it carries: the iOS counterpart card is the ActivityKit Live
 * Activity driven from `src/glanceable-ios/ios-sink.ts`, whose snapshot is
 * persisted in JS, so that side has no synchronous native write to move off the
 * JS thread.
 */
internal object DurableWrites {
  val queue: ExecutorService =
    Executors.newSingleThreadExecutor { Thread(it, "active-agents-live-update") }

  /** `queue` as the dispatcher a module's `runOnQueue` accepts. */
  val dispatcher: CoroutineDispatcher = queue.asCoroutineDispatcher()

  /**
   * Run one durable write on the queue and log a failure instead of throwing
   * it.
   *
   * A module entry point's promise is never consumed by the JS bridge, so a
   * thrown error would surface only as an unhandled rejection nobody can catch,
   * and a receiver's exception would take the process down on the broadcast
   * thread. The durable bodies keep their exact order and their guards; this
   * only decides where a failure is reported.
   */
  fun durable(block: () -> Unit) {
    try {
      block()
    } catch (error: Throwable) {
      Log.e(ACTIVE_AGENTS_TAG, "Active agents live update failed", error)
    }
  }
}

/**
 * Run one broadcast's write on the durable queue, and finish the broadcast once
 * it lands.
 *
 * `goAsync` is what makes it legal: a broadcast has a short budget, and an
 * exception on its thread takes the process down, so the work moves here and
 * `finish()` marks the broadcast handled. `goAsync` also keeps the process alive
 * until then, which a plain submit would not.
 */
internal fun BroadcastReceiver.enqueueDurableWrite(block: () -> Unit) {
  val pending = goAsync()
  DurableWrites.queue.execute {
    try {
      DurableWrites.durable(block)
    } finally {
      pending.finish()
    }
  }
}