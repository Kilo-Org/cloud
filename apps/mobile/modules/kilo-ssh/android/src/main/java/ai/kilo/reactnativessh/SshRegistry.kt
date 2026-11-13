package ai.kilo.reactnativessh

import ai.kilo.reactnativessh.background.BackgroundSessions
import ai.kilo.reactnativessh.background.IdleNotifications
import ai.kilo.reactnativessh.terminal.TerminalSourceRegistry
import ai.kilo.reactnativessh.uniffi.CancelToken
import ai.kilo.reactnativessh.uniffi.ForwardHandle
import ai.kilo.reactnativessh.uniffi.SftpClient
import ai.kilo.reactnativessh.uniffi.SshSession
import android.content.Context
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** What a session was opened against, kept so a later runtime can name it. */
internal data class SessionTarget(val host: String, val port: Int, val username: String)

/** A forward together with what it was asked to do, so it can be described later. */
internal class ForwardEntry(
  val sessionId: String,
  val direction: String,
  val bindHost: String,
  val bindPort: Int,
  val port: Int,
  val handle: ForwardHandle,
)

/** The event channel of whichever module instance is attached, if any. */
internal fun interface SshEventSink {
  fun emit(name: String, payload: Map<String, Any?>)
}

/**
 * Every live SSH resource, owned by the process rather than by a module.
 *
 * Android destroys the module — and with it the JavaScript runtime — on a
 * reload, while the foreground service keeps the process and its sockets
 * alive. A new runtime therefore has to find sessions it never opened, so the
 * resources live here: the notification counts what this object holds and
 * `listSessions`/`listForwards` describe it. Nothing here outlives the process,
 * which is exactly the lifetime of the sockets.
 */
internal object SshRegistry {
  val sessionIds = IdSequence("session-")
  val shellIds = IdSequence("shell-")
  val sftpIds = IdSequence("sftp-")
  val forwardIds = IdSequence("forward-")

  private val sessions = ConcurrentHashMap<String, SshSession>()
  private val targets = ConcurrentHashMap<String, SessionTarget>()
  private val shells = ConcurrentHashMap<String, SshShellSource>()
  private val sftps = ConcurrentHashMap<String, SftpClient>()
  private val sftpSessions = ConcurrentHashMap<String, String>()
  private val forwards = ConcurrentHashMap<String, ForwardEntry>()
  private val cancels = ConcurrentHashMap<String, CancelToken>()
  private val hostKeyRequests = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
  private val promptRequests = ConcurrentHashMap<String, CompletableDeferred<List<String>?>>()

  @Volatile private var appContext: Context? = null

  /** The module instance currently attached to JavaScript, if one is alive. */
  @Volatile private var events: SshEventSink? = null

  fun attach(context: Context, sink: SshEventSink) {
    appContext = context.applicationContext
    events = sink
  }

  /** Drops a module that is going away, keeping every session it opened. */
  fun detach(sink: SshEventSink) {
    if (events === sink) {
      events = null
    }
  }

  fun emit(name: String, payload: Map<String, Any?>) {
    events?.emit(name, payload)
  }

  fun sessionCount(): Int = sessions.size

  fun session(sessionId: String): SshSession? = sessions[sessionId]

  fun putSession(sessionId: String, session: SshSession, target: SessionTarget) {
    targets[sessionId] = target
    sessions[sessionId] = session
  }

  fun removeSession(sessionId: String): SshSession? {
    targets.remove(sessionId)

    return sessions.remove(sessionId)
  }

  fun sessions(): Map<String, SshSession> = sessions

  fun shell(shellId: String): SshShellSource? = shells[shellId]

  fun putShell(shellId: String, source: SshShellSource) {
    shells[shellId] = source
    TerminalSourceRegistry.register(shellId, source)
  }

  fun removeShell(shellId: String): SshShellSource? {
    TerminalSourceRegistry.unregister(shellId)

    return shells.remove(shellId)
  }

  fun shellIdsOf(sessionId: String): List<String> =
    shells.filterValues { it.sessionId == sessionId }.keys.toList()

  fun putSftp(sftpId: String, sessionId: String, client: SftpClient) {
    sftpSessions[sftpId] = sessionId
    sftps[sftpId] = client
  }

  fun sftp(sftpId: String): SftpClient? = sftps[sftpId]

  fun removeSftp(sftpId: String): SftpClient? {
    sftpSessions.remove(sftpId)

    return sftps.remove(sftpId)
  }

  fun sftpIdsOf(sessionId: String): List<String> =
    sftpSessions.filterValues { it == sessionId }.keys.toList()

  fun putForward(forwardId: String, entry: ForwardEntry) {
    forwards[forwardId] = entry
  }

  fun removeForward(forwardId: String): ForwardEntry? = forwards.remove(forwardId)

  fun forwardIdsOf(sessionId: String): List<String> =
    forwards.filterValues { it.sessionId == sessionId }.keys.toList()

  fun putCancel(transferId: String, token: CancelToken) {
    cancels[transferId] = token
  }

  fun cancel(transferId: String): CancelToken? = cancels[transferId]

  fun removeCancel(transferId: String): CancelToken? = cancels.remove(transferId)

  fun putHostKeyRequest(requestId: String, decision: CompletableDeferred<Boolean>) {
    hostKeyRequests[requestId] = decision
  }

  fun hostKeyRequest(requestId: String): CompletableDeferred<Boolean>? = hostKeyRequests[requestId]

  fun removeHostKeyRequest(requestId: String) {
    hostKeyRequests.remove(requestId)
  }

  fun putPromptRequest(requestId: String, answers: CompletableDeferred<List<String>?>) {
    promptRequests[requestId] = answers
  }

  fun promptRequest(requestId: String): CompletableDeferred<List<String>?>? = promptRequests[requestId]

  fun removePromptRequest(requestId: String) {
    promptRequests.remove(requestId)
  }

  /** Everything a fresh runtime needs to rebuild its view of the sessions. */
  fun sessionRecords(): List<SessionInfoRecord> =
    sessions.keys.mapNotNull { sessionId ->
      val target = targets[sessionId] ?: return@mapNotNull null

      SessionInfoRecord(
        sessionId = sessionId,
        host = target.host,
        port = target.port,
        username = target.username,
        shellIds = shellIdsOf(sessionId),
        sftpIds = sftpIdsOf(sessionId),
        forwardIds = forwardIdsOf(sessionId),
      )
    }

  /** Every listener still running, with the connection it runs on. */
  fun forwardRecords(): List<ForwardInfoRecord> =
    forwards.map { (forwardId, entry) ->
      ForwardInfoRecord(
        forwardId = forwardId,
        sessionId = entry.sessionId,
        direction = entry.direction,
        bindHost = entry.bindHost,
        bindPort = entry.bindPort,
        port = entry.port,
      )
    }

  /**
   * Ends every session from the notification action. The teardown runs here
   * rather than in the module so it still works when no JavaScript runtime is
   * attached, which is the state a reload leaves behind.
   */
  fun disconnectAll() {
    shells.keys.toList().forEach { shellId ->
      IdleNotifications.release(shellId)
      removeShell(shellId)?.close()
    }

    val scope = CoroutineScope(Dispatchers.IO)
    sessions.keys.toList().forEach { sessionId ->
      val session = removeSession(sessionId) ?: return@forEach

      scope.launch { runCatching { session.disconnect() } }
    }

    sync()
    emit(EVENT_DISCONNECT_ALL, emptyMap())
  }

  /** Repoints the notification and the service at what is actually open. */
  fun sync() {
    val context = appContext ?: return

    BackgroundSessions.sync(context)
    emit(EVENT_SESSIONS_CHANGED, mapOf("count" to sessionCount()))
  }
}