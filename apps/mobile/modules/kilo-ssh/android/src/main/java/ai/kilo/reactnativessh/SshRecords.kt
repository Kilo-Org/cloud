package ai.kilo.reactnativessh

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** What JavaScript passes to `connect`. */
class ConnectConfigRecord : Record {
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var username: String = ""
  @Field var auth: AuthRecord = AuthRecord()
  @Field var appSessionId: String = ""
  @Field var connectTimeoutMs: Int = 15_000
  @Field var keepaliveIntervalS: Int = 15
}

/** A tagged union in one record: `type` selects which field is read. */
class AuthRecord : Record {
  @Field var type: String = ""
  @Field var password: String? = null
  @Field var privateKeyOpenssh: String? = null
  @Field var passphrase: String? = null
}

class ShellOptionsRecord : Record {
  @Field var term: String = "xterm-256color"
  @Field var cols: Int = 80
  @Field var rows: Int = 24
}

class GeneratedKeyRecord(
  @Field val privateKeyOpenssh: String,
  @Field val publicKeyOpenssh: String,
  @Field val fingerprintSha256: String,
) : Record

class ParsedKeyRecord(
  @Field val algorithm: String,
  @Field val publicKeyOpenssh: String,
  @Field val fingerprintSha256: String,
  @Field val encrypted: Boolean,
) : Record

class ExecOutputRecord(
  @Field val stdout: String,
  @Field val stderr: String,
  @Field val exitStatus: Int?,
) : Record

class SftpEntryRecord(
  @Field val name: String,
  @Field val kind: String,
  @Field val size: Double,
  @Field val modifiedUnix: Double?,
  @Field val permissions: Int?,
) : Record

class ForwardConfigRecord : Record {
  @Field var bindHost: String = "127.0.0.1"
  @Field var bindPort: Int = 0
  @Field var destHost: String = ""
  @Field var destPort: Int = 22
}

class ForwardStartRecord(
  @Field val forwardId: String,
  @Field val port: Int,
) : Record

/** A live session as the registry holds it, for a runtime that just started. */
class SessionInfoRecord(
  @Field val sessionId: String,
  @Field val appSessionId: String,
  @Field val host: String,
  @Field val port: Int,
  @Field val username: String,
  @Field val shellIds: List<String>,
  @Field val sftpIds: List<String>,
  @Field val forwardIds: List<String>,
) : Record

/** A live forward as the registry holds it. */
class ForwardInfoRecord(
  @Field val forwardId: String,
  @Field val sessionId: String,
  @Field val direction: String,
  @Field val bindHost: String,
  @Field val bindPort: Int,
  @Field val port: Int,
) : Record

internal class HostKeyRequestRecord(
  val sessionId: String,
  val requestId: String,
  val host: String,
  val port: Int,
  val algorithm: String,
  val publicKeyBase64: String,
  val fingerprintSha256: String,
) {
  fun toEvent(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "requestId" to requestId,
    "host" to host,
    "port" to port,
    "algorithm" to algorithm,
    "publicKeyBase64" to publicKeyBase64,
    "fingerprintSha256" to fingerprintSha256,
  )
}

internal class PromptRecord(val text: String, val echo: Boolean) {
  fun toEvent(): Map<String, Any?> = mapOf("text" to text, "echo" to echo)
}

internal class KeyboardInteractiveRequestRecord(
  val sessionId: String,
  val requestId: String,
  val name: String,
  val instructions: String,
  val prompts: List<PromptRecord>,
) {
  fun toEvent(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "requestId" to requestId,
    "name" to name,
    "instructions" to instructions,
    "prompts" to prompts.map { it.toEvent() },
  )
}

internal class DisconnectRecord(val sessionId: String, val reason: String) {
  fun toEvent(): Map<String, Any?> = mapOf("sessionId" to sessionId, "reason" to reason)
}
