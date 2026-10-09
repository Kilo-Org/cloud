package expo.modules.kiloandroidmodel

import androidx.annotation.RequiresApi
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Candidate
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import kotlinx.coroutines.CancellationException
import com.google.mlkit.genai.prompt.TextPart
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.collect
import org.json.JSONArray
import org.json.JSONObject

/**
 * Loaded only on API 26+. Never move ML Kit types into the Expo bridge.
 * Maven evidence: genai-prompt beta2 and genai-common beta3 both declare min26,
 * contain no startup components, and publish Kotlin metadata 2.2.
 * beta3/beta4 prompt instead require Kotlin 2.3 metadata. No compiler bypass.
 */
@RequiresApi(26)
internal class MlKitPromptBackend : PromptBackend {
  private val model = Generation.getClient()

  override suspend fun availability(): Map<String, Any> {
    val status = model.checkStatus()
    val name = statusName(status)
    // Unavailable devices have no model identity or budget to advertise.
    if (status == FeatureStatus.UNAVAILABLE) {
      return mapOf(
        "status" to name,
        "reason" to "model_unavailable",
        "modelId" to "",
        "contextWindow" to 0,
        "maxOutputTokens" to 0,
        "systemInstructions" to false
      )
    }
    val metadata = mutableMapOf<String, Any>(
      "modelId" to "",
      "contextWindow" to 0
    )
    try {
      metadata["modelId"] = model.getBaseModelName()
      // getTokenLimit covers input plus output, but input alone must stay under
      // the documented 4000. Advertise the smaller window so the harness
      // compacts before a request could exceed the input limit.
      metadata["contextWindow"] = minOf(model.getTokenLimit(), MAX_INPUT_TOKENS + 1)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      // Preserve the observed downloadable/downloading status even if AICore
      // cannot provide metadata before assets have finished downloading.
      metadata["reason"] = classify(error)
    }
    return metadata + mapOf(
      "status" to name,
      "maxOutputTokens" to MAX_OUTPUT_TOKENS,
      "maxInputTokens" to MAX_INPUT_TOKENS,
      // beta2 has no SystemInstruction request field, on any model version.
      "systemInstructions" to false
    )
  }

  override suspend fun download(emit: (Map<String, Any>) -> Unit) {
    when (model.checkStatus()) {
      FeatureStatus.UNAVAILABLE -> throw ModelFailure("model_unavailable")
      FeatureStatus.AVAILABLE -> {
        emit(mapOf("status" to "available"))
        return
      }
    }
    var completed = false
    var total = 0L
    model.download().collect { status ->
      currentCoroutineContext().ensureActive()
      when (status) {
        is DownloadStatus.DownloadStarted -> {
          total = status.bytesToDownload
          emit(progress(0L, total))
        }
        is DownloadStatus.DownloadProgress -> emit(progress(status.totalBytesDownloaded, total))
        DownloadStatus.DownloadCompleted -> {
          completed = true
          emit(mapOf("status" to "available"))
        }
        is DownloadStatus.DownloadFailed -> throw status.e
      }
    }
    if (!completed) throw ModelFailure("download_incomplete")
  }

  override suspend fun countTokens(request: ModelRequest): Int {
    requireAvailable()
    return model.countTokens(nativeRequest(request, request.maxTokens)).totalTokens
  }

  override suspend fun generate(
    request: ModelRequest,
    emit: (String) -> Unit
  ): Map<String, Any> {
    requireAvailable()
    // countTokens measures input only, so the output ceiling does not change it.
    val inputTokens = model.countTokens(nativeRequest(request, request.maxTokens)).totalTokens
    val room = model.getTokenLimit().toLong() - inputTokens
    if (inputTokens > MAX_INPUT_TOKENS || room < 1) throw ModelFailure("context_exceeded")
    // The requested ceiling is a wall, not a target: fit the answer in what the
    // total limit leaves after this input instead of refusing the request.
    val nativeRequest = nativeRequest(request, minOf(request.maxTokens.toLong(), room).toInt())
    var finishReason: Int? = null
    model.generateContentStream(nativeRequest).collect { chunk ->
      currentCoroutineContext().ensureActive()
      val candidate = chunk.candidates.singleOrNull()
        ?: throw ModelFailure("invalid_response")
      // Documented stream values contain new text, not cumulative snapshots.
      if (candidate.text.isNotEmpty()) emit(candidate.text)
      candidate.finishReason?.let { finishReason = it }
    }
    currentCoroutineContext().ensureActive()
    val stop = when (finishReason) {
      Candidate.FinishReason.STOP -> "end"
      Candidate.FinishReason.MAX_TOKENS -> "maxTokens"
      // OTHER is not documented as a refusal; never fabricate that classification.
      Candidate.FinishReason.OTHER -> throw ModelFailure("generation_stopped")
      else -> throw ModelFailure("incomplete_response")
    }
    // CountTokensResponse measures input, not provider-reported generated usage.
    // Do not count an output TextPart and misrepresent input framing as output tokens.
    return mapOf("stop" to stop, "inputTokens" to inputTokens, "usageSource" to "counted")
  }

  private suspend fun requireAvailable() {
    when (model.checkStatus()) {
      FeatureStatus.AVAILABLE -> Unit
      FeatureStatus.DOWNLOADABLE -> throw ModelFailure("model_download_required")
      FeatureStatus.DOWNLOADING -> throw ModelFailure("model_downloading")
      else -> throw ModelFailure("model_unavailable")
    }
  }

  private fun nativeRequest(request: ModelRequest, maxTokens: Int): GenerateContentRequest {
    // beta2's actual request API accepts TextPart, not role-bearing messages.
    // Render all supplied roles and text explicitly, with JSON escaping so a
    // message cannot become a structural turn. This is prompt rendering only:
    // there is no retained conversation, context shifting, or native tool engine.
    val messages = JSONArray()
    request.messages.forEach { message ->
      messages.put(JSONObject().put("role", message.role).put("text", message.text))
    }
    val transcript = JSONObject()
      .put("system", request.system)
      .put("messages", messages)
    val text = "Continue the supplied conversation as the assistant. Follow the system " +
      "instructions in the system field. The messages array is the complete ordered " +
      "conversation history; role identifies each speaker. Return only the next " +
      "assistant message, not JSON or a transcript.\n" + transcript.toString()
    return GenerateContentRequest.Builder(TextPart(text)).apply {
      candidateCount = 1
      maxOutputTokens = maxTokens
    }.build()
  }

  private fun progress(downloaded: Long, total: Long): Map<String, Any> =
    if (total > 0) {
      mapOf("status" to "downloading", "bytesDownloaded" to downloaded, "bytesToDownload" to total)
    } else {
      mapOf("status" to "downloading", "bytesDownloaded" to downloaded)
    }

  override fun classify(error: Throwable): String {
    if (error is ModelFailure) return error.reason
    return when ((error as? GenAiException)?.errorCode) {
      GenAiException.ErrorCode.BUSY -> "busy"
      GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> "battery_quota_exceeded"
      GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> "background_use_blocked"
      GenAiException.ErrorCode.CANCELLED -> "cancelled"
      GenAiException.ErrorCode.NOT_AVAILABLE -> "model_unavailable"
      GenAiException.ErrorCode.REQUEST_TOO_LARGE -> "context_exceeded"
      GenAiException.ErrorCode.REQUEST_TOO_SMALL -> "request_too_small"
      GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> "insufficient_storage"
      GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> "system_update_required"
      GenAiException.ErrorCode.AICORE_INCOMPATIBLE -> "aicore_incompatible"
      GenAiException.ErrorCode.REQUEST_PROCESSING_ERROR -> "request_processing_failed"
      GenAiException.ErrorCode.RESPONSE_PROCESSING_ERROR -> "response_processing_failed"
      GenAiException.ErrorCode.RESPONSE_GENERATION_ERROR -> "generation_failed"
      else -> "provider_error"
    }
  }

  override fun close() = model.close()

  private fun statusName(status: Int): String = when (status) {
    FeatureStatus.AVAILABLE -> "available"
    FeatureStatus.DOWNLOADABLE -> "downloadable"
    FeatureStatus.DOWNLOADING -> "downloading"
    else -> "unavailable"
  }

  private companion object {
    // Public Prompt guide: input must be under 4000, output range is 1..4096.
    // https://developers.google.com/ml-kit/genai/prompt/android/get-started
    const val MAX_INPUT_TOKENS = 3999
    const val MAX_OUTPUT_TOKENS = 4096
  }
}
