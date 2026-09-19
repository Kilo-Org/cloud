package expo.modules.kiloappactions

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.jni.JavaScriptFunction
import expo.modules.kotlin.jni.JavaScriptValue
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of the shared app-action contract.
 *
 * The exported entry points (`KiloActionActivity`) hand every request to
 * [AppActionDispatcher], and the dispatcher is the JS handler the shared
 * contract installs with `registerAppActionDispatcher`. Nothing here decides
 * what an action does: the native side turns an Intent into the contract
 * payload and carries the result back to the caller.
 */
class KiloAppActionsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KiloAppActions")

    /**
     * Stores the JS dispatcher and returns the payloads that arrived before the
     * runtime was ready, so an entry point that ran while the app was cold is
     * not lost. JS runs each returned payload through the same dispatcher.
     */
    Function("registerAppActionDispatcher") { handler: JavaScriptFunction<JavaScriptValue> ->
      AppActionDispatcher.register(handler) { block ->
        // A JSI function may only be invoked on the JS thread, and an entry point
        // calls in from the main thread. `appContext.reactContext` is typed as a
        // plain Android `Context`, so the hop goes through the runtime's
        // scheduler, which owns the JS thread.
        appContext.runtime.schedule(block)
      }
    }

    /**
     * The outcome of one payload, for a caller that asked for a result.
     *
     * The JS dispatcher is async, so its `AppActionResult` is not the value the
     * native side can read back from the call. Expo's Android API has no JS
     * promise to await (`expo-modules-jsi` is Apple-only), so the dispatcher
     * reports the outcome here instead, and the waiting entry point answers its
     * caller with it.
     */
    Function("completeAppAction") { payload: String, result: String ->
      AppActionDispatcher.complete(payload, result)
    }

    OnDestroy {
      AppActionDispatcher.clear()
    }
  }
}

/**
 * The process-wide hand-off between the exported entry points and the JS
 * dispatcher.
 *
 * A payload that arrives before `registerAppActionDispatcher` buffers here and
 * is returned to JS at registration, so the same handler runs it. A caller that
 * asked for a result waits on [complete], which the dispatcher answers with the
 * real outcome — never a fire-and-forget acknowledgement.
 */
internal object AppActionDispatcher {
  /** The registered JS dispatcher and the hop that puts a call on its thread. */
  private class Registration(
    val handler: JavaScriptFunction<JavaScriptValue>,
    val queue: (() -> Unit) -> Unit
  )

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  private var registration: Registration? = null
  private val buffered = mutableListOf<String>()
  private val waiters = mutableMapOf<String, (String) -> Unit>()

  /** Stores the JS dispatcher and returns the payloads that arrived first. */
  fun register(
    next: JavaScriptFunction<JavaScriptValue>,
    queue: (() -> Unit) -> Unit
  ): List<String> = synchronized(lock) {
    registration = Registration(next, queue)
    val pending = buffered.toList()
    buffered.clear()
    pending
  }

  /**
   * Hands one payload to the JS dispatcher. Returns false, buffering the
   * payload, when the runtime is not up yet: the entry point starts the app,
   * and registration drains the payload through that same dispatcher.
   *
   * A dispatcher that answers synchronously returns the result JSON, and the
   * waiting caller gets it right away. The dispatcher in the app is async
   * (`native-bridge.ts`), so its outcome arrives through [complete] instead.
   */
  fun dispatch(payload: String): Boolean {
    val active = synchronized(lock) { registration }
    if (active == null) {
      synchronized(lock) { buffered.add(payload) }
      return false
    }
    val invoke = {
      // The JS dispatcher owns its own error reporting (`app-action-dispatch.ts`
      // captures to Sentry), so a throw here only means this payload produced no
      // result for the caller.
      runCatching {
        val returned = active.handler(payload)
        if (returned.isString()) {
          complete(payload, returned.getString())
        }
      }
      Unit
    }
    active.queue(invoke)
    return true
  }

  /** Registers the result the caller of an entry point is waiting for. */
  fun await(payload: String, onResult: (String) -> Unit) {
    synchronized(lock) { waiters[payload] = onResult }
  }

  /** Drops a waiter the entry point no longer needs, after its timeout. */
  fun abandon(payload: String) {
    synchronized(lock) { waiters.remove(payload) }
  }

  /** Answers a waiting caller with the dispatcher's result. */
  fun complete(payload: String, result: String) {
    val waiter = synchronized(lock) { waiters.remove(payload) } ?: return
    main.post { waiter(result) }
  }

  /** Drops the dispatcher and its waiters when the JS runtime goes away. */
  fun clear() {
    synchronized(lock) {
      registration = null
      waiters.clear()
    }
  }
}
