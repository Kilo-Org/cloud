package expo.modules.kiloandroidmodel

import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class KiloAndroidModelModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  // All operation state, events, and promise settlement are serialized on Main.
  private var foreground = false
  private var active: Operation? = null

  override fun definition() = ModuleDefinition {
    Name("KiloAndroidModel")
    Events("onModelEvent", "onModelDownload")

    OnCreate {
      // Only ever raise the flag here: the resume event may already have run.
      // React replays onHostResume to a listener added while resumed.
      scope.launch {
        if (appContext.currentActivity?.hasWindowFocus() == true) foreground = true
      }
    }
    OnActivityEntersForeground {
      scope.launch { foreground = true }
    }
    OnActivityEntersBackground {
      scope.launch {
        foreground = false
        // Inference is foreground-only. The system-managed download is not
        // inference, so leaving the app does not abort it.
        if (active?.isDownload == false) stopActive("background_use_blocked")
      }
    }
    OnActivityDestroys {
      scope.launch {
        foreground = false
        stopActive("released")
      }
    }
    OnDestroy {
      scope.launch {
        stopActive("released")
        scope.cancel()
      }
    }

    // A status check never takes the inference slot: checking while a reply
    // streams must neither read as busy nor stop the reply.
    AsyncFunction("availability") { promise: Promise ->
      enqueue(promise) { promise.resolve(availability()) }
    }

    // Only this explicit JS entry point initiates the system-managed download.
    AsyncFunction("download") { promise: Promise ->
      startOperation(promise, isDownload = true) { operation ->
        val backend = createBackend(operation)
        backend.download { event ->
          if (!operation.terminal) sendEvent("onModelDownload", event)
        }
        null
      }
    }

    AsyncFunction("countTokens") { request: Map<String, Any?>, promise: Promise ->
      startOperation(promise) { operation ->
        createBackend(operation).countTokens(ModelRequest.parse(request))
      }
    }

    AsyncFunction("generate") { request: Map<String, Any?>, promise: Promise ->
      val id = request["id"] as? String ?: ""
      startOperation(promise, id = id) { operation ->
        if (id.isEmpty()) throw ModelFailure("invalid_request")
        createBackend(operation).generate(ModelRequest.parse(request)) { text ->
          if (!operation.terminal) {
            sendEvent("onModelEvent", mapOf("id" to id, "kind" to "delta", "text" to text))
          }
        }
      }
    }

    AsyncFunction("cancel") { id: String, promise: Promise ->
      enqueue(promise) {
        val matched = active?.id == id
        if (matched) stopActive("cancelled")
        promise.resolve(matched)
      }
    }

    AsyncFunction("release") { promise: Promise ->
      enqueue(promise) {
        stopActive("released")
        promise.resolve(null)
      }
    }
  }

  private fun startOperation(
    promise: Promise,
    id: String? = null,
    isDownload: Boolean = false,
    body: suspend (Operation) -> Any?
  ) {
    enqueue(promise) {
      // Reject rather than queue or overwrite a live inference. The rejected
      // promise is the busy result; don't send an error under a reused live id.
      if (active != null) {
        promise.reject("busy", "busy", null)
        return@enqueue
      }
      val operation = Operation(promise, id, isDownload, currentCoroutineContext()[Job]!!)
      active = operation
      try {
        if (!foreground) throw ModelFailure("background_use_blocked")
        val result = body(operation)
        currentCoroutineContext().ensureActive()
        if (!operation.terminal) {
          operation.terminal = true
          if (id != null) {
            @Suppress("UNCHECKED_CAST")
            val completion = result as Map<String, Any>
            sendEvent("onModelEvent", completion + mapOf("id" to id, "kind" to "done"))
            promise.resolve(null)
          } else {
            promise.resolve(result)
          }
        }
      } catch (error: CancellationException) {
        fail(operation, "cancelled")
      } catch (error: Exception) {
        fail(operation, (error as? ModelFailure)?.reason
          ?: operation.backend?.classify(error) ?: "provider_error")
      } finally {
        close(operation)
        if (active === operation) active = null
      }
    }
  }

  private suspend fun availability(): Map<String, Any> {
    if (Build.VERSION.SDK_INT < 26) return unavailable("unsupported_os")
    // Like createBackend: the kept ML Kit class loads only after the SDK guard.
    val backend = try {
      MlKitPromptBackend()
    } catch (error: Exception) {
      return unavailable("provider_error")
    }
    return try {
      backend.availability()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      unavailable(backend.classify(error))
    } finally {
      closeQuietly(backend)
    }
  }

  private fun createBackend(operation: Operation): PromptBackend {
    if (Build.VERSION.SDK_INT < 26) throw ModelFailure("unsupported_os")
    // The kept implementation class is first loaded here, AFTER the SDK guard.
    // Neither this module's fields nor PromptBackend reference any ML Kit type.
    return MlKitPromptBackend().also { operation.backend = it }
  }

  private fun enqueue(promise: Promise, action: suspend () -> Unit) {
    if (!scope.isActive) {
      promise.reject("released", "released", null)
      return
    }
    scope.launch { action() }
  }

  private fun stopActive(reason: String) {
    val operation = active ?: return
    // Settle before cancel/close so even late native callbacks cannot emit done.
    fail(operation, reason)
    operation.job.cancel()
    close(operation)
    active = null
  }

  private fun fail(operation: Operation, reason: String) {
    if (operation.terminal) return
    operation.terminal = true
    operation.id?.let { id ->
      sendEvent("onModelEvent", mapOf("id" to id, "kind" to "error", "reason" to reason))
    }
    if (operation.isDownload) {
      sendEvent("onModelDownload", mapOf("status" to "error", "reason" to reason))
    }
    // Never attach provider exceptions: their messages may contain prompt data.
    operation.promise.reject(reason, reason, null)
  }

  private fun close(operation: Operation) {
    val backend = operation.backend ?: return
    operation.backend = null
    closeQuietly(backend)
  }

  private fun closeQuietly(backend: PromptBackend) {
    // Cleanup errors must not replace the one terminal event or leak SDK text.
    try {
      backend.close()
    } catch (_: Exception) {
      Unit
    }
  }

  private fun unavailable(reason: String): Map<String, Any> = mapOf(
    "status" to "unavailable",
    "reason" to reason,
    "modelId" to "",
    "contextWindow" to 0,
    "maxOutputTokens" to 0,
    "systemInstructions" to false
  )

  private class Operation(
    val promise: Promise,
    val id: String?,
    val isDownload: Boolean,
    val job: Job,
    var backend: PromptBackend? = null,
    var terminal: Boolean = false
  )
}
