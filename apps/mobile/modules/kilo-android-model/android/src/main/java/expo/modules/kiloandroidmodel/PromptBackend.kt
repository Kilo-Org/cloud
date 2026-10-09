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

internal data class ModelMessage(val role: String, val text: String)

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
        ModelMessage(role, text)
      }
      val tokens = (value["maxTokens"] as? Number)?.toDouble()
        ?: throw ModelFailure("invalid_request")
      if (!tokens.isFinite() || tokens < 1 || tokens > 4096 || tokens % 1.0 != 0.0) {
        throw ModelFailure("invalid_max_tokens")
      }
      return ModelRequest(system, messages, tokens.toInt())
    }
  }
}
