import ExpoModulesCore

public final class ReactNativeSshModule: Module {
  private let state = SshModuleState.shared

  public func definition() -> ModuleDefinition {
    Name("ReactNativeSsh")
    Events(
      "onHostKey",
      "onKeyboardInteractive",
      "onDisconnect",
      "onSessionsChanged",
      "onCommandFinished",
      "onDisconnectAll",
      "onTransferProgress",
      "onForwardError"
    )

    Function("coreVersion") { () -> String in
      coreVersion()
    }

    AsyncFunction("generateEd25519Key") { (comment: String) throws -> GeneratedKeyRecord in
      let key = try translate { try generateEd25519Key(comment: comment) }

      return GeneratedKeyRecord(
        privateKeyOpenssh: key.privateKeyOpenssh,
        publicKeyOpenssh: key.publicKeyOpenssh,
        fingerprintSha256: key.fingerprintSha256
      )
    }

    Function("parsePrivateKey") { (pem: String, passphrase: String?) throws -> ParsedKeyRecord in
      let key = try translate { try parsePrivateKey(pem: pem, passphrase: passphrase) }

      return ParsedKeyRecord(
        algorithm: key.algorithm,
        publicKeyOpenssh: key.publicKeyOpenssh,
        fingerprintSha256: key.fingerprintSha256,
        encrypted: key.encrypted
      )
    }

    AsyncFunction("encryptExport") { (plaintextJson: String, passphrase: String) throws -> String in
      try translate { try encryptExport(plaintextJson: plaintextJson, passphrase: passphrase) }
    }

    AsyncFunction("decryptExport") { (armored: String, passphrase: String) throws -> String in
      try translate { try decryptExport(armored: armored, passphrase: passphrase) }
    }

    AsyncFunction("connect") { (config: ConnectConfigRecord) async throws -> String in
      try await self.connectSession(config)
    }

    AsyncFunction("connectVia") { (jumpSessionId: String, config: ConnectConfigRecord) async throws -> String in
      try await self.connectSession(config, via: jumpSessionId)
    }

    AsyncFunction("exec") { (sessionId: String, command: String) async throws -> ExecOutputRecord in
      try await self.runCommand(sessionId, command)
    }

    AsyncFunction("disconnect") { (sessionId: String) async throws in
      try await self.disconnectSession(sessionId)
    }

    AsyncFunction("openShell") { (sessionId: String, options: ShellOptionsRecord) async throws -> String in
      try await self.openShell(sessionId, options)
    }

    Function("closeShell") { (shellId: String) in
      self.closeShell(shellId)
    }

    Function("listSessions") { () -> [SessionInfoRecord] in
      self.state.sessionRecords()
    }

    Function("listForwards") { () -> [ForwardInfoRecord] in
      self.state.forwardRecords()
    }

    Function("configureBackgroundSessions") { (_: String, _: String, _: String) -> Int in
      self.state.sessionRecords().count
    }

    Function("updateSessionsBody") { (_: String) -> Void in }

    Function("notifyWhenIdle") { (_: String, _: Double, _: String, _: String?) -> Bool in
      false
    }

    Function("answerHostKey") { (requestId: String, accept: Bool) -> Bool in
      self.state.takeHostKeyRequest(requestId)?.resolve(accept) ?? false
    }

    Function("answerPrompts") { (requestId: String, answers: [String]?) -> Bool in
      let reply = answers.map(PromptReply.answers) ?? .cancelled

      return self.state.takePromptRequest(requestId)?.resolve(reply) ?? false
    }

    Function("isRetryableCode") { (code: String) -> Bool in
      self.isRetryable(code)
    }

    AsyncFunction("openSftp") { (sessionId: String) async throws -> String in
      guard let session = self.state.session(sessionId) else {
        throw channelClosed(sessionId)
      }

      let sftpId = self.state.sftpIds.next()
      let client = try await translateAsync { try await session.openSftp() }
      self.state.store(sftp: client, id: sftpId, sessionId: sessionId)

      return sftpId
    }

    AsyncFunction("closeSftp") { (sftpId: String) async throws in
      guard let client = self.state.removeSftp(sftpId) else {
        return
      }

      try await translateAsync { try await client.shutdown() }
    }

    AsyncFunction("sftpList") { (sftpId: String, path: String) async throws -> [SftpEntryRecord] in
      let client = try self.sftp(sftpId)
      let entries = try await translateAsync { try await client.list(path: path) }

      return entries.map(sftpEntryRecord)
    }

    AsyncFunction("sftpStat") { (sftpId: String, path: String) async throws -> SftpEntryRecord in
      let client = try self.sftp(sftpId)
      let entry = try await translateAsync { try await client.stat(path: path) }

      return sftpEntryRecord(entry)
    }

    AsyncFunction("sftpRealpath") { (sftpId: String, path: String) async throws -> String in
      let client = try self.sftp(sftpId)

      return try await translateAsync { try await client.realpath(path: path) }
    }

    AsyncFunction("sftpMkdir") { (sftpId: String, path: String) async throws in
      let client = try self.sftp(sftpId)

      try await translateAsync { try await client.mkdir(path: path) }
    }

    AsyncFunction("sftpRename") { (sftpId: String, from: String, to: String) async throws in
      let client = try self.sftp(sftpId)

      try await translateAsync { try await client.rename(from: from, to: to) }
    }

    AsyncFunction("sftpRemoveFile") { (sftpId: String, path: String) async throws in
      let client = try self.sftp(sftpId)

      try await translateAsync { try await client.removeFile(path: path) }
    }

    AsyncFunction("sftpRemoveDir") { (sftpId: String, path: String) async throws in
      let client = try self.sftp(sftpId)

      try await translateAsync { try await client.removeDir(path: path) }
    }

    AsyncFunction("sftpDownload")
    { (sftpId: String, remotePath: String, localPath: String, transferId: String) async throws -> Double in
      let client = try self.sftp(sftpId)

      return try await self.transfer(transferId) { progress, cancel in
        try await client.download(
          remotePath: remotePath,
          localPath: localPath,
          progress: progress,
          cancel: cancel
        )
      }
    }

    AsyncFunction("sftpUpload")
    { (sftpId: String, localPath: String, remotePath: String, transferId: String) async throws -> Double in
      let client = try self.sftp(sftpId)

      return try await self.transfer(transferId) { progress, cancel in
        try await client.upload(
          localPath: localPath,
          remotePath: remotePath,
          progress: progress,
          cancel: cancel
        )
      }
    }

    Function("cancelTransfer") { (transferId: String) in
      self.state.cancel(transferId)?.cancel()
    }

    AsyncFunction("startLocalForward")
    { (sessionId: String, config: ForwardConfigRecord) async throws -> ForwardStartRecord in
      try await self.startForward(sessionId, config, direction: "local") { session, native, sink in
        try await session.startLocalForward(config: native, events: sink)
      }
    }

    AsyncFunction("startRemoteForward")
    { (sessionId: String, config: ForwardConfigRecord) async throws -> ForwardStartRecord in
      try await self.startForward(sessionId, config, direction: "remote") { session, native, sink in
        try await session.startRemoteForward(config: native, events: sink)
      }
    }

    AsyncFunction("stopForward") { (forwardId: String) async throws in
      guard let entry = self.state.removeForward(forwardId) else {
        return
      }

      try await translateAsync { try await entry.handle.stop() }
    }

    /// A reload builds a new module while the sockets it opened stay live, so
    /// teardown leaves the shared state — and every session in it — intact. The
    /// process ending is what closes them.
    OnDestroy {}
  }

  private func isRetryable(_ code: String) -> Bool {
    categoryIsRetryable(category: code)
  }

  private func connectSession(
    _ config: ConnectConfigRecord,
    via jumpSessionId: String? = nil
  ) async throws -> String {
    let sessionId = state.sessionIds.next()
    let target = SessionTarget(
      host: config.host,
      port: config.port,
      username: config.username,
      appSessionId: config.appSessionId
    )
    let handler = JsSessionHandler(
      sessionId: sessionId,
      requestHostKey: { [weak self] request in
        await self?.requestHostKey(request) ?? false
      },
      requestPrompts: { [weak self] request in
        await self?.requestPrompts(request) ?? .cancelled
      },
      notifyDisconnect: { [weak self] notice in
        self?.sendEvent("onDisconnect", notice.toEvent())
      }
    )

    let session: SshSession
    if let jumpSessionId {
      guard let jump = state.session(jumpSessionId) else {
        throw channelClosed(jumpSessionId)
      }
      session = try await translateAsync {
        try await SshSession.connectVia(jump: jump, config: config.toNative(), handler: handler)
      }
    } else {
      session = try await translateAsync {
        try await SshSession.connect(config: config.toNative(), handler: handler)
      }
    }

    state.store(session: session, id: sessionId, target: target)

    return sessionId
  }

  private func sftp(_ sftpId: String) throws -> SftpClient {
    guard let client = state.sftp(sftpId) else {
      throw channelClosed(sftpId)
    }

    return client
  }

  private func transfer(
    _ transferId: String,
    run: (TransferProgress, CancelToken) async throws -> UInt64
  ) async throws -> Double {
    let cancel = CancelToken()
    state.store(cancel: cancel, id: transferId)
    defer { _ = state.removeCancel(transferId) }
    let progress = TransferProgressSink(transferId: transferId) { event, payload in
      self.sendEvent(event, payload)
    }

    return Double(try await translateAsync { try await run(progress, cancel) })
  }

  private func startForward(
    _ sessionId: String,
    _ config: ForwardConfigRecord,
    direction: String,
    start: (SshSession, ForwardConfig, ForwardSink) async throws -> ForwardHandle
  ) async throws -> ForwardStartRecord {
    guard let session = state.session(sessionId) else {
      throw channelClosed(sessionId)
    }

    let forwardId = state.forwardIds.next()
    let sink = ForwardErrorSink(sessionId: sessionId) { event, payload in
      self.sendEvent(event, payload)
    }
    let handle = try await translateAsync {
      try await start(session, config.toNative(), sink)
    }
    let port = Int(handle.actualPort())
    state.store(
      forward: ForwardEntry(
        sessionId: sessionId,
        direction: direction,
        bindHost: config.bindHost,
        bindPort: config.bindPort,
        port: port,
        handle: handle
      ),
      id: forwardId
    )

    var record = ForwardStartRecord()
    record.forwardId = forwardId
    record.port = port
    return record
  }

  private func runCommand(_ sessionId: String, _ command: String) async throws -> ExecOutputRecord {
    guard let session = state.session(sessionId) else {
      throw channelClosed(sessionId)
    }

    let result = try await translateAsync { try await session.exec(command: command) }

    var output = ExecOutputRecord()
    output.stdout = String(decoding: result.stdout, as: UTF8.self)
    output.stderr = String(decoding: result.stderr, as: UTF8.self)
    output.exitStatus = result.exitStatus.map { Int($0) }
    return output
  }

  private func disconnectSession(_ sessionId: String) async throws {
    guard let session = state.removeSession(sessionId) else {
      return
    }

    state.shellIds(of: sessionId).forEach { closeShell($0) }
    try await translateAsync { try await session.disconnect() }
  }

  private func openShell(_ sessionId: String, _ options: ShellOptionsRecord) async throws -> String {
    guard let session = state.session(sessionId) else {
      throw channelClosed(sessionId)
    }

    let shellId = state.shellIds.next()
    let source = try await translateAsync {
      try await SshShellSource.open(
        sessionId: sessionId,
        session: session,
        term: options.term,
        cols: options.cols,
        rows: options.rows
      )
    }

    state.store(shell: source, id: shellId)
    TerminalSourceRegistry.shared.register(shellId, source)

    return shellId
  }

  private func closeShell(_ shellId: String) {
    guard let source = state.removeShell(shellId) else {
      return
    }

    TerminalSourceRegistry.shared.unregister(shellId)
    source.close()
  }

  private func requestHostKey(_ request: HostKeyRequest) async -> Bool {
    let pending = PendingRequest<Bool>()
    state.store(hostKeyRequest: pending, id: request.requestId)

    defer { _ = state.takeHostKeyRequest(request.requestId) }
    sendEvent("onHostKey", request.toEvent())

    return await pending.wait()
  }

  private func requestPrompts(_ request: KeyboardInteractiveRequest) async -> PromptReply {
    let pending = PendingRequest<PromptReply>()
    state.store(promptRequest: pending, id: request.requestId)

    defer { _ = state.takePromptRequest(request.requestId) }
    sendEvent("onKeyboardInteractive", request.toEvent())

    return await pending.wait()
  }
}

private func channelClosed(_ sessionId: String) -> Exception {
  Exception(name: "SshError", description: "session \(sessionId) is not connected", code: "ChannelClosed")
}

private func translate<Value>(_ call: () throws -> Value) throws -> Value {
  do {
    return try call()
  } catch let error as SshError {
    throw error.codedException
  }
}

private func translateAsync<Value>(_ call: () async throws -> Value) async throws -> Value {
  do {
    return try await call()
  } catch let error as SshError {
    throw error.codedException
  }
}

private extension ConnectConfigRecord {
  func toNative() throws -> ConnectConfig {
    guard port >= 1 && port <= 65535 else {
      throw Exception(name: "SshError", description: "port must be between 1 and 65535", code: "Protocol")
    }
    guard connectTimeoutMs > 0, keepaliveIntervalS >= 0 else {
      throw Exception(name: "SshError", description: "invalid timeout or keepalive", code: "Protocol")
    }

    return ConnectConfig(
      host: host,
      port: UInt16(port),
      username: username,
      auth: try auth.toNative(),
      connectTimeoutMs: UInt32(connectTimeoutMs),
      keepaliveIntervalS: UInt32(keepaliveIntervalS)
    )
  }
}

private extension ForwardConfigRecord {
  func toNative() throws -> ForwardConfig {
    guard bindPort >= 0 && bindPort <= 65535 else {
      throw Exception(name: "SshError", description: "bindPort must be between 0 and 65535", code: "Protocol")
    }
    guard destPort >= 1 && destPort <= 65535 else {
      throw Exception(name: "SshError", description: "destPort must be between 1 and 65535", code: "Protocol")
    }

    return ForwardConfig(
      bindHost: bindHost,
      bindPort: UInt16(bindPort),
      destHost: destHost,
      destPort: UInt16(destPort)
    )
  }
}

private extension AuthRecord {
  func toNative() throws -> AuthMethod {
    switch type {
    case "password":
      guard let password else {
        throw Exception(name: "SshError", description: "password auth needs a password", code: "Protocol")
      }
      return .password(password: password)
    case "key":
      guard let privateKeyOpenssh else {
        throw Exception(name: "SshError", description: "key auth needs privateKeyOpenssh", code: "Protocol")
      }
      return .key(privateKeyOpenssh: privateKeyOpenssh, passphrase: passphrase)
    case "keyboardInteractive":
      return .keyboardInteractive
    default:
      throw Exception(name: "SshError", description: "unknown auth type: \(type)", code: "Protocol")
    }
  }
}
