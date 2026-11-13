package ai.kilo.reactnativessh

import ai.kilo.reactnativessh.uniffi.Prompt
import ai.kilo.reactnativessh.uniffi.SessionHandler

/**
 * Bridges the core's session decisions to JavaScript events.
 *
 * Each request is registered before the event is emitted and removed as soon
 * as the decision arrives, so `answerHostKey`/`answerPrompts` never see a stale
 * id and a dropped connection releases the pending wait.
 */
internal class JsSessionHandler(
  private val sessionId: String,
  private val requestHostKey: suspend (HostKeyRequestRecord) -> Boolean,
  private val requestPrompts: suspend (KeyboardInteractiveRequestRecord) -> List<String>?,
  private val notifyDisconnect: (DisconnectRecord) -> Unit,
) : SessionHandler {
  override suspend fun verifyHostKey(
    host: String,
    port: UShort,
    algorithm: String,
    publicKeyBase64: String,
    fingerprintSha256: String,
  ): Boolean = requestHostKey(
    HostKeyRequestRecord(
      sessionId = sessionId,
      requestId = requestIds.next(),
      host = host,
      port = port.toInt(),
      algorithm = algorithm,
      publicKeyBase64 = publicKeyBase64,
      fingerprintSha256 = fingerprintSha256,
    )
  )

  override suspend fun keyboardInteractive(
    name: String,
    instructions: String,
    prompts: List<Prompt>,
  ): List<String>? = requestPrompts(
    KeyboardInteractiveRequestRecord(
      sessionId = sessionId,
      requestId = requestIds.next(),
      name = name,
      instructions = instructions,
      prompts = prompts.map { PromptRecord(it.text, it.echo) },
    )
  )

  override fun onDisconnect(reason: String) {
    notifyDisconnect(DisconnectRecord(sessionId, reason))
  }

  private val requestIds = IdSequence("request-")
}
