package expo.modules.kiloappactions

import expo.modules.kotlin.jni.JavaScriptFunction
import expo.modules.kotlin.jni.JavaScriptValue
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.types.ConverterContext

/**
 * The Android half of the shared app-action contract.
 *
 * The exported entry points (`KiloActionActivity`) hand every request to
 * [AppActionDispatcher], and the dispatcher is the JS handler the shared
 * contract installs with `registerAppActionDispatcher`. Nothing here decides
 * what an action does: the native side turns an Intent into the contract
 * payload and hands it over.
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
      AppActionDispatcher.register(handler, appContext) { block ->
        // A JSI function may only be invoked on the JS thread, and an entry point
        // calls in from the main thread. `appContext.reactContext` is typed as a
        // plain Android `Context`, so the hop goes through the runtime's
        // scheduler, which owns the JS thread.
        appContext.runtime.schedule(block)
      }
    }

    /**
     * Whether a `StartAgent` delivered through this entry point asks the user
     * first. It does: the shared dispatcher shows the prompt and the user
     * confirms it before a session starts. iOS does not declare it, because its
     * intents run with no screen.
     */
    Function("startAgentNeedsConfirmation") { true }

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
 * is returned to JS at registration, so the same handler runs it. The outcome
 * of a run belongs to the app: the entry point hands the request over and
 * finishes, and no result travels back to whoever started it.
 */
internal object AppActionDispatcher {
  /** The registered JS dispatcher and the hop that puts a call on its thread. */
  private class Registration(
    val handler: JavaScriptFunction<JavaScriptValue>,
    val converterContext: ConverterContext,
    val queue: (() -> Unit) -> Unit
  )

  private val lock = Any()
  private var registration: Registration? = null
  private val buffered = mutableListOf<String>()

  /** Stores the JS dispatcher and returns the payloads that arrived first. */
  fun register(
    next: JavaScriptFunction<JavaScriptValue>,
    converterContext: ConverterContext,
    queue: (() -> Unit) -> Unit
  ): List<String> = synchronized(lock) {
    registration = Registration(next, converterContext, queue)
    val pending = buffered.toList()
    buffered.clear()
    pending
  }

  /**
   * Hands one payload to the JS dispatcher. Returns false, buffering the
   * payload, when the runtime is not up yet: the entry point starts the app,
   * and registration drains the payload through that same dispatcher.
   */
  fun dispatch(payload: String): Boolean {
    val active = synchronized(lock) { registration }
    if (active == null) {
      synchronized(lock) { buffered.add(payload) }
      return false
    }
    val invoke = {
      // The JS dispatcher owns its own error reporting (`app-action-dispatch.ts`
      // captures to Sentry), so a throw here only ends this payload's run.
      runCatching { active.handler(payload, converterContext = active.converterContext) }
      Unit
    }
    active.queue(invoke)
    return true
  }

  /** Drops the dispatcher when the JS runtime goes away. */
  fun clear() {
    synchronized(lock) {
      registration = null
    }
  }
}
