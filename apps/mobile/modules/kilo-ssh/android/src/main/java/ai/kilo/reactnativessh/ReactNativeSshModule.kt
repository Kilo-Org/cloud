package ai.kilo.reactnativessh

import ai.kilo.reactnativessh.background.BackgroundSessions
import ai.kilo.reactnativessh.background.IdleNotifications
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
import kotlinx.coroutines.CompletableDeferred

internal const val EVENT_HOST_KEY = "onHostKey"
internal const val EVENT_KEYBOARD_INTERACTIVE = "onKeyboardInteractive"
internal const val EVENT_DISCONNECT = "onDisconnect"
internal const val EVENT_SESSIONS_CHANGED = "onSessionsChanged"
internal const val EVENT_COMMAND_FINISHED = "onCommandFinished"
internal const val EVENT_DISCONNECT_ALL = "onDisconnectAll"
internal const val EVENT_TRANSFER_PROGRESS = "onTransferProgress"
internal const val EVENT_FORWARD_ERROR = "onForwardError"

/**
 * The JavaScript surface. Every resource lives in [SshRegistry], which outlives
 * a reload; this class only translates calls in both directions and is free to
 * be thrown away.
 */
class ReactNativeSshModule : Module() {
  private val sshRegistry = SshRegistry

  private val sink = SshEventSink { name, payload -> runCatching { sendEvent(name, payload) } }

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
      sshRegistry.attach(androidContext, sink)
      BackgroundSessions.disconnectAll = sshRegistry::disconnectAll
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
      sshRegistry.closeShell(shellId)
    }

    Function("configureBackgroundSessions") { channelName: String, title: String, disconnectAllLabel: String ->
      BackgroundSessions.configure(androidContext, channelName, title, disconnectAllLabel)
    }

    Function("updateSessionsBody") { body: String ->
      BackgroundSessions.setBody(androidContext, body)
    }

    Function("listSessions") {
      sshRegistry.sessionRecords()
    }

    Function("listForwards") {
      sshRegistry.forwardRecords()
    }

    Function("notifyWhenIdle") { shellId: String, quietMs: Double, title: String, body: String? ->
      val source = sshRegistry.shell(shellId)

      if (source == null || source.terminated) {
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
      sshRegistry.hostKeyRequest(requestId)?.complete(accept) == true
    }

    Function("answerPrompts") { requestId: String, answers: List<String>? ->
      sshRegistry.promptRequest(requestId)?.complete(answers) == true
    }

    Function("isRetryableCode") { code: String ->
      categoryIsRetryable(code)
    }

    AsyncFunction("openSftp").SuspendBody { sessionId: String ->
      val sftpId = sshRegistry.sftpIds.next()
      val client = translateSuspendFailures { session(sessionId).openSftp() }

      sshRegistry.putSftp(sftpId, sessionId, client)

      // The session can be disconnected while the client is opening; sweeping
      // by session only sees entries that exist, so check after storing.
      if (sshRegistry.session(sessionId) == null) {
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
      sshRegistry.cancel(transferId)?.cancel()
    }

    AsyncFunction("startLocalForward").SuspendBody { sessionId: String, config: ForwardConfigRecord ->
      registerForward(sessionId, "local", config) {
        session(sessionId).startLocalForward(config.toNative(), forwardSink(sessionId))
      }
    }

    AsyncFunction("startRemoteForward").SuspendBody { sessionId: String, config: ForwardConfigRecord ->
      registerForward(sessionId, "remote", config) {
        session(sessionId).startRemoteForward(config.toNative(), forwardSink(sessionId))
      }
    }

    AsyncFunction("stopForward").SuspendBody { forwardId: String ->
      stopForward(forwardId)
    }

    /**
     * A reload destroys the module while the foreground service keeps the
     * process, and with it every socket. The sessions stay in the registry for
     * the next runtime to reattach to, so teardown only drops this instance's
     * event channel.
     */
    OnDestroy {
      sshRegistry.detach(sink)
    }
  }

  private val androidContext: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private suspend fun connectSession(
    config: ConnectConfigRecord,
    connect: suspend (SessionHandler) -> SshSession,
  ): String {
    val sessionId = sshRegistry.sessionIds.next()
    val registry = sshRegistry
    val handler = JsSessionHandler(
      sessionId = sessionId,
      requestIds = registry.requestIds,
      requestHostKey = ::requestHostKey,
      requestPrompts = ::requestPrompts,
      // The socket can die while no runtime is attached, so the notice and the
      // release go through the registry rather than this instance.
      notifyDisconnect = { record ->
        registry.emit(EVENT_DISCONNECT, record.toEvent())
        registry.releaseDisconnected(record.sessionId)
      },
    )

    val target = SessionTarget(
      host = config.host,
      port = config.port,
      username = config.username,
      appSessionId = config.appSessionId,
    )
    sshRegistry.putSession(sessionId, translateSuspendFailures { connect(handler) }, target)
    sshRegistry.sync()

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
    val session = sshRegistry.releaseSession(sessionId) ?: return

    sshRegistry.sync()
    translateSuspendFailures { session.disconnect() }
  }

  private suspend fun openShell(sessionId: String, options: ShellOptionsRecord): String {
    val session = session(sessionId)
    val shellId = sshRegistry.shellIds.next()
    val source = translateSuspendFailures {
      SshShellSource.open(sessionId, session, options.term, options.cols, options.rows) {
        sshRegistry.closeShell(shellId)
      }
    }

    sshRegistry.putShell(shellId, source)

    return shellId
  }

  private suspend fun closeSftp(sftpId: String) {
    sshRegistry.removeSftp(sftpId)?.let { client -> translateSuspendFailures { client.shutdown() } }
  }

  private suspend fun stopForward(forwardId: String) {
    sshRegistry.removeForward(forwardId)?.let { entry -> translateSuspendFailures { entry.handle.stop() } }
  }

  private suspend fun transfer(
    transferId: String,
    run: suspend (TransferProgress, CancelToken) -> ULong,
  ): Double {
    val cancel = CancelToken()
    sshRegistry.putCancel(transferId, cancel)

    return try {
      translateSuspendFailures { run(progressSink(transferId), cancel) }.toDouble()
    } finally {
      sshRegistry.removeCancel(transferId)
    }
  }

  private suspend fun registerForward(
    sessionId: String,
    direction: String,
    config: ForwardConfigRecord,
    start: suspend () -> ForwardHandle,
  ): ForwardStartRecord {
    val forwardId = sshRegistry.forwardIds.next()
    val handle = translateSuspendFailures(start)
    val port = handle.actualPort().toInt()

    sshRegistry.putForward(
      forwardId,
      ForwardEntry(
        sessionId = sessionId,
        direction = direction,
        bindHost = config.bindHost,
        bindPort = config.bindPort,
        port = port,
        handle = handle,
      ),
    )

    // The session can be disconnected while the forward is starting, and the
    // sweep already ran; a forward nobody owns would listen forever.
    if (sshRegistry.session(sessionId) == null) {
      stopForward(forwardId)
      throw SshException.ChannelClosed("session $sessionId is not connected").toCodedException()
    }

    return ForwardStartRecord(forwardId, port)
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
    sshRegistry.putHostKeyRequest(request.requestId, decision)

    return try {
      sendEvent(EVENT_HOST_KEY, request.toEvent())
      decision.await()
    } finally {
      sshRegistry.removeHostKeyRequest(request.requestId)
    }
  }

  private suspend fun requestPrompts(request: KeyboardInteractiveRequestRecord): List<String>? {
    val answers = CompletableDeferred<List<String>?>()
    sshRegistry.putPromptRequest(request.requestId, answers)

    return try {
      sendEvent(EVENT_KEYBOARD_INTERACTIVE, request.toEvent())
      answers.await()
    } finally {
      sshRegistry.removePromptRequest(request.requestId)
    }
  }

  private fun session(sessionId: String): SshSession =
    sshRegistry.session(sessionId)
      ?: throw SshException.ChannelClosed("session $sessionId is not connected").toCodedException()

  private fun sftp(sftpId: String): SftpClient =
    sshRegistry.sftp(sftpId)
      ?: throw SshException.ChannelClosed("sftp $sftpId is not open").toCodedException()
}

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
