package ai.kilo.reactnativessh

import ai.kilo.reactnativessh.background.BackgroundSessions
import ai.kilo.reactnativessh.background.IdleNotifications
import ai.kilo.reactnativessh.terminal.TerminalSourceRegistry
import ai.kilo.reactnativessh.uniffi.AuthMethod
import ai.kilo.reactnativessh.uniffi.CancelToken
import ai.kilo.reactnativessh.uniffi.ConnectConfig
import ai.kilo.reactnativessh.uniffi.Entry
import ai.kilo.reactnativessh.uniffi.EntryKind
import ai.kilo.reactnativessh.uniffi.ForwardConfig
import ai.kilo.reactnativessh.uniffi.ForwardHandle
import ai.kilo.reactnativessh.uniffi.ForwardSink
import ai.kilo.reactnativessh.uniffi.SessionHandler
import ai.kilo.reactnativessh.uniffi.SftpClient
import ai.kilo.reactnativessh.uniffi.SshException
import ai.kilo.reactnativessh.uniffi.SshSession
import ai.kilo.reactnativessh.uniffi.TransferProgress
import ai.kilo.reactnativessh.uniffi.categoryIsRetryable
import ai.kilo.reactnativessh.uniffi.coreVersion
import ai.kilo.reactnativessh.uniffi.decryptExport
import ai.kilo.reactnativessh.uniffi.encryptExport
import ai.kilo.reactnativessh.uniffi.generateEd25519Key
import ai.kilo.reactnativessh.uniffi.parsePrivateKey
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

internal const val EVENT_HOST_KEY = "onHostKey"
internal const val EVENT_KEYBOARD_INTERACTIVE = "onKeyboardInteractive"
internal const val EVENT_DISCONNECT = "onDisconnect"
internal const val EVENT_SESSIONS_CHANGED = "onSessionsChanged"
internal const val EVENT_COMMAND_FINISHED = "onCommandFinished"
internal const val EVENT_DISCONNECT_ALL = "onDisconnectAll"
internal const val EVENT_TRANSFER_PROGRESS = "onTransferProgress"
internal const val EVENT_FORWARD_ERROR = "onForwardError"

class ReactNativeSshModule : Module() {
  private val sessions = ConcurrentHashMap<String, SshSession>()
  private val shells = ConcurrentHashMap<String, SshShellSource>()
  private val sftps = ConcurrentHashMap<String, SessionSftp>()
  private val forwards = ConcurrentHashMap<String, SessionForward>()
  private val cancels = ConcurrentHashMap<String, CancelToken>()
  private val hostKeyRequests = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
  private val promptRequests = ConcurrentHashMap<String, CompletableDeferred<List<String>?>>()
  private val sessionIds = IdSequence("session-")
  private val shellIds = IdSequence("shell-")
  // One sequence for every session: the pending host-key and prompt maps are
  // keyed by request id alone, so a per-session counter would collide.
  private val requestIds = IdSequence("request-")
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var reportedSessionCount = 0
  private val sftpIds = IdSequence("sftp-")
  private val forwardIds = IdSequence("forward-")

  override fun definition() = ModuleDefinition {
    Name("ReactNativeSsh")
    Events(
      EVENT_HOST_KEY,
      EVENT_KEYBOARD_INTERACTIVE,
      EVENT_DISCONNECT,
      EVENT_SESSIONS_CHANGED,
      EVENT_COMMAND_FINISHED,
      EVENT_DISCONNECT_ALL,
      EVENT_TRANSFER_PROGRESS,
      EVENT_FORWARD_ERROR,
    )

    OnCreate {
      BackgroundSessions.disconnectAll = ::disconnectAll
    }

    Function("coreVersion") {
      coreVersion()
    }

    AsyncFunction("generateEd25519Key") { comment: String ->
      val key = translateFailures { generateEd25519Key(comment) }

      GeneratedKeyRecord(key.privateKeyOpenssh, key.publicKeyOpenssh, key.fingerprintSha256)
    }

    Function("parsePrivateKey") { pem: String, passphrase: String? ->
      val key = translateFailures { parsePrivateKey(pem, passphrase) }

      ParsedKeyRecord(
        algorithm = key.algorithm,
        publicKeyOpenssh = key.publicKeyOpenssh,
        fingerprintSha256 = key.fingerprintSha256,
        encrypted = key.encrypted,
      )
    }

    AsyncFunction("encryptExport") { plaintextJson: String, passphrase: String ->
      translateFailures { encryptExport(plaintextJson, passphrase) }
    }

    AsyncFunction("decryptExport") { armored: String, passphrase: String ->
      translateFailures { decryptExport(armored, passphrase) }
    }

    AsyncFunction("connect").SuspendBody { config: ConnectConfigRecord ->
      connectSession(config) { handler -> SshSession.connect(config.toNative(), handler) }
    }

    AsyncFunction("connectVia").SuspendBody { jumpSessionId: String, config: ConnectConfigRecord ->
      val jump = session(jumpSessionId)

      connectSession(config) { handler -> SshSession.connectVia(jump, config.toNative(), handler) }
    }

    AsyncFunction("exec").SuspendBody { sessionId: String, command: String ->
      runCommand(sessionId, command)
    }

    AsyncFunction("disconnect").SuspendBody { sessionId: String ->
      disconnectSession(sessionId)
    }

    AsyncFunction("openShell").SuspendBody { sessionId: String, options: ShellOptionsRecord ->
      openShell(sessionId, options)
    }

    Function("closeShell") { shellId: String ->
      closeShell(shellId)
    }

    Function("configureBackgroundSessions") { channelName: String, title: String, disconnectAllLabel: String ->
      BackgroundSessions.configure(androidContext, channelName, title, disconnectAllLabel)
    }

    Function("updateSessionsBody") { body: String ->
      BackgroundSessions.setBody(androidContext, body)
    }

    Function("notifyWhenIdle") { shellId: String, quietMs: Double, title: String, body: String? ->
      val source = shells[shellId]

      if (source == null) {
        false
      } else {
        IdleNotifications.watch(
          context = androidContext,
          shellId = shellId,
          quietMs = quietMs.toLong(),
          activity = source.activity,
          title = title,
          body = body,
          onFinished = { sendEvent(EVENT_COMMAND_FINISHED, mapOf("shellId" to shellId)) },
        )

        true
      }
    }

    Function("answerHostKey") { requestId: String, accept: Boolean ->
      hostKeyRequests[requestId]?.complete(accept) == true
    }

    Function("answerPrompts") { requestId: String, answers: List<String>? ->
      promptRequests[requestId]?.complete(answers) == true
    }

    Function("isRetryableCode") { code: String ->
      categoryIsRetryable(code)
    }

    AsyncFunction("openSftp").SuspendBody { sessionId: String ->
      val sftpId = sftpIds.next()
      val client = translateSuspendFailures { session(sessionId).openSftp() }

      sftps[sftpId] = SessionSftp(sessionId, client)

      // The session can be disconnected while the client is opening; sweeping
      // by session only sees entries that exist, so check after storing.
      if (!sessions.containsKey(sessionId)) {
        closeSftp(sftpId)
        throw SshException.ChannelClosed("session $sessionId is not connected").toCodedException()
      }

      sftpId
    }

    AsyncFunction("closeSftp").SuspendBody { sftpId: String ->
      closeSftp(sftpId)
    }

    AsyncFunction("sftpList").SuspendBody { sftpId: String, path: String ->
      translateSuspendFailures { sftp(sftpId).list(path) }.map(Entry::toRecord)
    }

    AsyncFunction("sftpStat").SuspendBody { sftpId: String, path: String ->
      translateSuspendFailures { sftp(sftpId).stat(path) }.toRecord()
    }

    AsyncFunction("sftpRealpath").SuspendBody { sftpId: String, path: String ->
      translateSuspendFailures { sftp(sftpId).realpath(path) }
    }

    AsyncFunction("sftpMkdir").SuspendBody { sftpId: String, path: String ->
      translateSuspendFailures { sftp(sftpId).mkdir(path) }
    }

    AsyncFunction("sftpRename").SuspendBody { sftpId: String, from: String, to: String ->
      translateSuspendFailures { sftp(sftpId).rename(from, to) }
    }

    AsyncFunction("sftpRemoveFile").SuspendBody { sftpId: String, path: String ->
      translateSuspendFailures { sftp(sftpId).removeFile(path) }
    }

    AsyncFunction("sftpRemoveDir").SuspendBody { sftpId: String, path: String ->
      translateSuspendFailures { sftp(sftpId).removeDir(path) }
    }

    AsyncFunction("sftpDownload")
      .SuspendBody { sftpId: String, remotePath: String, localPath: String, transferId: String ->
        transfer(transferId) { progress, cancel ->
          sftp(sftpId).download(remotePath, localPath, progress, cancel)
        }
      }

    AsyncFunction("sftpUpload")
      .SuspendBody { sftpId: String, localPath: String, remotePath: String, transferId: String ->
        transfer(transferId) { progress, cancel ->
          sftp(sftpId).upload(localPath, remotePath, progress, cancel)
        }
      }

    Function("cancelTransfer") { transferId: String ->
      cancels[transferId]?.cancel()
    }

    AsyncFunction("startLocalForward").SuspendBody { sessionId: String, config: ForwardConfigRecord ->
      registerForward(sessionId) {
        session(sessionId).startLocalForward(config.toNative(), forwardSink(sessionId))
      }
    }

    AsyncFunction("startRemoteForward").SuspendBody { sessionId: String, config: ForwardConfigRecord ->
      registerForward(sessionId) {
        session(sessionId).startRemoteForward(config.toNative(), forwardSink(sessionId))
      }
    }

    AsyncFunction("stopForward").SuspendBody { forwardId: String ->
      stopForward(forwardId)
    }

    OnDestroy {
      scope.cancel()

      // The teardown outlives the module, so it gets its own scope.
      val teardown = CoroutineScope(Dispatchers.IO)

      shells.keys.forEach(::closeShell)
      sftps.values.forEach { entry -> teardown.launch { runCatching { entry.client.shutdown() } } }
      forwards.values.forEach { entry -> teardown.launch { runCatching { entry.handle.stop() } } }
      cancels.values.forEach { token -> token.cancel() }
      sessions.forEach { (_, session) -> teardown.launch { runCatching { session.disconnect() } } }
      sessions.clear()
      stopBackgroundSessions()
      BackgroundSessions.disconnectAll = null
    }
  }

  private val androidContext: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private suspend fun connectSession(
    config: ConnectConfigRecord,
    connect: suspend (SessionHandler) -> SshSession,
  ): String {
    val sessionId = sessionIds.next()
    val handler = JsSessionHandler(
      sessionId = sessionId,
      requestIds = requestIds,
      requestHostKey = ::requestHostKey,
      requestPrompts = ::requestPrompts,
      notifyDisconnect = { record ->
        // The module can be gone already when a socket dies during teardown.
        runCatching { sendEvent(EVENT_DISCONNECT, record.toEvent()) }
        removeSession(record.sessionId)
      },
    )

    sessions[sessionId] = translateSuspendFailures { connect(handler) }
    syncSessions()

    return sessionId
  }

  private suspend fun runCommand(sessionId: String, command: String): ExecOutputRecord {
    val session = session(sessionId)
    val result = translateSuspendFailures { session.exec(command) }

    return ExecOutputRecord(
      stdout = result.stdout.toString(Charsets.UTF_8),
      stderr = result.stderr.toString(Charsets.UTF_8),
      exitStatus = result.exitStatus?.toInt(),
    )
  }

  private suspend fun disconnectSession(sessionId: String) {
    val session = sessions.remove(sessionId) ?: return

    closeShells(sessionId)
    closeSftps(sessionId)
    stopForwards(sessionId)
    syncSessions()
    translateSuspendFailures { session.disconnect() }
  }

  private suspend fun openShell(sessionId: String, options: ShellOptionsRecord): String {
    val session = session(sessionId)
    val shellId = shellIds.next()
    val source = translateSuspendFailures {
      // A channel that ends releases itself: the module holds no shell past its exit.
      SshShellSource.open(sessionId, session, options.term, options.cols, options.rows) {
        closeShell(shellId)
      }
    }

    shells[shellId] = source
    TerminalSourceRegistry.register(shellId, source)

    // The channel can end before it is registered, in which case the callback
    // above had nothing to remove yet.
    if (source.terminated) closeShell(shellId)

    return shellId
  }

  private fun closeShell(shellId: String) {
    IdleNotifications.release(shellId)
    TerminalSourceRegistry.unregister(shellId)
    shells.remove(shellId)?.close()
  }

  private fun closeShells(sessionId: String) {
    shells.filterValues { it.sessionId == sessionId }.keys.forEach(::closeShell)
  }

  /** Every SFTP client the session opened follows it out, whatever the caller did. */
  private suspend fun closeSftps(sessionId: String) {
    sftps.filterValues { it.sessionId == sessionId }.keys.forEach { sftpId ->
      runCatching { closeSftp(sftpId) }
    }
  }

  private suspend fun stopForwards(sessionId: String) {
    forwards.filterValues { it.sessionId == sessionId }.keys.forEach { forwardId ->
      runCatching { stopForward(forwardId) }
    }
  }

  private suspend fun closeSftp(sftpId: String) {
    sftps.remove(sftpId)?.let { entry -> translateSuspendFailures { entry.client.shutdown() } }
  }

  private suspend fun stopForward(forwardId: String) {
    forwards.remove(forwardId)?.let { entry -> translateSuspendFailures { entry.handle.stop() } }
  }

  /** Runs on the core's disconnect callback thread, so the shutdowns are queued. */
  private fun removeSession(sessionId: String) {
    if (sessions.remove(sessionId) == null) {
      return
    }

    closeShells(sessionId)
    scope.launch {
      closeSftps(sessionId)
      stopForwards(sessionId)
    }
    syncSessions()
  }

  /** Every open session, and nothing else, keeps the foreground service alive. */
  private fun syncSessions() {
    val count = sessions.size

    if (count == reportedSessionCount) {
      return
    }

    reportedSessionCount = count
    val context = appContext.reactContext?.applicationContext ?: return

    BackgroundSessions.update(context, count)
    sendEvent(EVENT_SESSIONS_CHANGED, mapOf("count" to count))
  }

  private fun stopBackgroundSessions() {
    val context = appContext.reactContext?.applicationContext ?: return

    BackgroundSessions.update(context, 0)
  }

  private fun disconnectAll() {
    shells.keys.toList().forEach(::closeShell)

    sessions.keys.toList().forEach { sessionId ->
      val session = sessions.remove(sessionId) ?: return@forEach

      scope.launch {
        closeSftps(sessionId)
        stopForwards(sessionId)
      }
      scope.launch { runCatching { session.disconnect() } }
    }

    syncSessions()
    sendEvent(EVENT_DISCONNECT_ALL)
  }

  private suspend fun transfer(
    transferId: String,
    run: suspend (TransferProgress, CancelToken) -> ULong,
  ): Double {
    val cancel = CancelToken()
    cancels[transferId] = cancel

    return try {
      translateSuspendFailures { run(progressSink(transferId), cancel) }.toDouble()
    } finally {
      cancels.remove(transferId)
    }
  }

  private suspend fun registerForward(sessionId: String, start: suspend () -> ForwardHandle): ForwardStartRecord {
    val forwardId = forwardIds.next()
    val handle = translateSuspendFailures(start)

    forwards[forwardId] = SessionForward(sessionId, handle)

    // The session can be disconnected while the forward is starting, and the
    // sweep already ran; a forward nobody owns would listen forever.
    if (!sessions.containsKey(sessionId)) {
      stopForward(forwardId)
      throw SshException.ChannelClosed("session $sessionId is not connected").toCodedException()
    }

    return ForwardStartRecord(forwardId, handle.actualPort().toInt())
  }

  private fun progressSink(transferId: String) = object : TransferProgress {
    override fun onProgress(transferred: ULong, total: ULong?) {
      runCatching {
        sendEvent(
          EVENT_TRANSFER_PROGRESS,
          mapOf(
            "transferId" to transferId,
            "transferred" to transferred.toDouble(),
            "total" to total?.toDouble(),
          ),
        )
      }
    }
  }

  private fun forwardSink(sessionId: String) = object : ForwardSink {
    override fun onError(message: String) {
      runCatching {
        sendEvent(EVENT_FORWARD_ERROR, mapOf("sessionId" to sessionId, "message" to message))
      }
    }
  }

  private suspend fun requestHostKey(request: HostKeyRequestRecord): Boolean {
    val decision = CompletableDeferred<Boolean>()
    hostKeyRequests[request.requestId] = decision

    return try {
      sendEvent(EVENT_HOST_KEY, request.toEvent())
      decision.await()
    } finally {
      hostKeyRequests.remove(request.requestId)
    }
  }

  private suspend fun requestPrompts(request: KeyboardInteractiveRequestRecord): List<String>? {
    val answers = CompletableDeferred<List<String>?>()
    promptRequests[request.requestId] = answers

    return try {
      sendEvent(EVENT_KEYBOARD_INTERACTIVE, request.toEvent())
      answers.await()
    } finally {
      promptRequests.remove(request.requestId)
    }
  }

  private fun session(sessionId: String): SshSession =
    sessions[sessionId]
      ?: throw SshException.ChannelClosed("session $sessionId is not connected").toCodedException()

  private fun sftp(sftpId: String): SftpClient =
    sftps[sftpId]?.client
      ?: throw SshException.ChannelClosed("sftp $sftpId is not open").toCodedException()
}

/** An SFTP client and the session whose shutdown it shares. */
private class SessionSftp(val sessionId: String, val client: SftpClient)

/** A port forward and the session whose shutdown it shares. */
private class SessionForward(val sessionId: String, val handle: ForwardHandle)

/** Runs a core call, translating its failure into a coded JavaScript error. */
private inline fun <T> translateFailures(call: () -> T): T = try {
  call()
} catch (error: SshException) {
  throw error.toCodedException()
}

private suspend fun <T> translateSuspendFailures(call: suspend () -> T): T = try {
  call()
} catch (error: SshException) {
  throw error.toCodedException()
}

private fun Entry.toRecord() = SftpEntryRecord(
  name = name,
  kind = kind.eventName(),
  size = size.toDouble(),
  modifiedUnix = modifiedUnix?.toDouble(),
  permissions = permissions?.toInt(),
)

private fun EntryKind.eventName(): String = when (this) {
  EntryKind.FILE -> "file"
  EntryKind.DIRECTORY -> "directory"
  EntryKind.SYMLINK -> "symlink"
  EntryKind.OTHER -> "other"
}

private fun ForwardConfigRecord.toNative(): ForwardConfig {
  require(bindPort in 0..65535) { "bindPort must be between 0 and 65535" }
  require(destPort in 1..65535) { "destPort must be between 1 and 65535" }

  return ForwardConfig(
    bindHost = bindHost,
    bindPort = bindPort.toUShort(),
    destHost = destHost,
    destPort = destPort.toUShort(),
  )
}

private fun AuthRecord.toNative(): AuthMethod = when (type) {
  "password" -> AuthMethod.Password(requireNotNull(password) { "password auth needs a password" })
  "key" -> AuthMethod.Key(
    privateKeyOpenssh = requireNotNull(privateKeyOpenssh) { "key auth needs privateKeyOpenssh" },
    passphrase = passphrase,
  )
  "keyboardInteractive" -> AuthMethod.KeyboardInteractive
  else -> throw CodedException("Protocol", "unknown auth type: $type", null)
}

private fun ConnectConfigRecord.toNative(): ConnectConfig {
  require(port in 1..65535) { "port must be between 1 and 65535" }
  require(connectTimeoutMs > 0) { "connectTimeoutMs must be positive" }
  require(keepaliveIntervalS >= 0) { "keepaliveIntervalS must not be negative" }

  return ConnectConfig(
    host = host,
    port = port.toUShort(),
    username = username,
    auth = auth.toNative(),
    connectTimeoutMs = connectTimeoutMs.toUInt(),
    keepaliveIntervalS = keepaliveIntervalS.toUInt(),
  )
}
