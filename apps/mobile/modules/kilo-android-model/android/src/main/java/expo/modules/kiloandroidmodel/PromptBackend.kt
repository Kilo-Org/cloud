package expo.modules.kiloandroidmodel

internal interface PromptBackend {
  suspend fun availability(): Map<String, Any>
  suspend fun download(emit: (Map<String, Any>) -> Unit)
  suspend fun countTokens(request: ModelRequest): Int
  suspend fun generate(request: ModelRequest, emit: (String) -> Unit): Map<String, Any>
  fun classify(error: Throwable): String
  fun close()
}

internal class ModelFailure(val reason: String) : Exception(reason)

/**
 * The availability payload of a provider that cannot serve a request: no model
 * identity and no budget to advertise, only [reason] and the reported [status].
 */
internal fun unavailableAvailability(
  reason: String,
  status: String = "unavailable"
): Map<String, Any> = mapOf(
  "status" to status,
  "reason" to reason,
  "modelId" to "",
  "contextWindow" to 0,
  "maxOutputTokens" to 0,
  "systemInstructions" to false
)

/** A base64 image as JavaScript sends it. The backend decodes it off the main thread. */
internal data class ModelImage(val media: String, val data: String)

internal data class ModelMessage(
  val role: String,
  val text: String,
  val images: List<ModelImage> = emptyList()
)

internal data class ModelRequest(
  val system: String,
  val messages: List<ModelMessage>,
  val maxTokens: Int
) {
  companion object {
    fun parse(value: Map<String, Any?>): ModelRequest {
      val system = value["system"] as? String ?: throw ModelFailure("invalid_request")
      val rawMessages = value["messages"] as? List<*> ?: throw ModelFailure("invalid_request")
      if (rawMessages.isEmpty()) throw ModelFailure("invalid_request")
      val messages = rawMessages.map { item ->
        val message = item as? Map<*, *> ?: throw ModelFailure("invalid_request")
        val role = message["role"] as? String ?: throw ModelFailure("invalid_request")
        val text = message["text"] as? String ?: throw ModelFailure("invalid_request")
        if (role != "user" && role != "assistant") throw ModelFailure("invalid_request")
        ModelMessage(role, text, parseImages(message["images"], role))
      }
      val tokens = (value["maxTokens"] as? Number)?.toDouble()
        ?: throw ModelFailure("invalid_request")
      // The backend that serves the request owns the output range it advertises.
      if (!tokens.isFinite() || tokens < 1 || tokens % 1.0 != 0.0 ||
        tokens > MlKitPromptBackend.MAX_OUTPUT_TOKENS
      ) {
        throw ModelFailure("invalid_max_tokens")
      }
      return ModelRequest(system, messages, tokens.toInt())
    }

    // Only a user message carries images, and only as a list of media/data pairs.
    private fun parseImages(value: Any?, role: String): List<ModelImage> {
      if (value == null) return emptyList()
      val items = value as? List<*> ?: throw ModelFailure("invalid_request")
      if (items.isNotEmpty() && role != "user") throw ModelFailure("invalid_request")
      return items.map { item ->
        val image = item as? Map<*, *> ?: throw ModelFailure("invalid_request")
        val media = image["media"] as? String ?: throw ModelFailure("invalid_request")
        val data = image["data"] as? String ?: throw ModelFailure("invalid_request")
        if (!media.startsWith("image/") || data.isEmpty()) throw ModelFailure("invalid_image")
        ModelImage(media, data)
      }
    }
  }
}
