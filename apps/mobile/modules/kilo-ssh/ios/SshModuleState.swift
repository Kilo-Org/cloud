import Foundation

/// What a session was opened against, kept so a later runtime can name it.
struct SessionTarget: Sendable {
  let host: String
  let port: Int
  let username: String
  /// The JavaScript session this connection belongs to, so a reload adopts its row.
  let appSessionId: String
}

/// A forward together with what it was asked to do, so it can be described later.
struct ForwardEntry: @unchecked Sendable {
  let sessionId: String
  let direction: String
  let bindHost: String
  let bindPort: Int
  let port: Int
  let handle: ForwardHandle
}

/**
 * Every live SSH resource, shared by the JavaScript thread and the Rust callback
 * threads.
 *
 * The state is a process-wide singleton: a reload builds a new module instance
 * while the sockets it opened are still live, so the next runtime has to find
 * the sessions it never opened. The identifiers live here too, so a fresh
 * runtime cannot reissue an id a live session still holds.
 */
final class SshModuleState: @unchecked Sendable {
  static let shared = SshModuleState()

  let sessionIds = IdSequence(prefix: "session-")
  let shellIds = IdSequence(prefix: "shell-")
  let sftpIds = IdSequence(prefix: "sftp-")
  let forwardIds = IdSequence(prefix: "forward-")

  private let lock = NSLock()
  private var sessions: [String: SshSession] = [:]
  private var targets: [String: SessionTarget] = [:]
  private var shells: [String: SshShellSource] = [:]
  private var sftps: [String: SftpClient] = [:]
  private var sftpSessions: [String: String] = [:]
  private var forwards: [String: ForwardEntry] = [:]
  private var cancels: [String: CancelToken] = [:]
  private var hostKeyRequests: [String: PendingRequest<Bool>] = [:]
  private var promptRequests: [String: PendingRequest<PromptReply>] = [:]

  func store(session: SshSession, id: String, target: SessionTarget) {
    lock.lock()
    targets[id] = target
    sessions[id] = session
    lock.unlock()
  }

  func session(_ id: String) -> SshSession? {
    lock.lock()
    defer { lock.unlock() }
    return sessions[id]
  }

  func removeSession(_ id: String) -> SshSession? {
    lock.lock()
    defer { lock.unlock() }
    targets.removeValue(forKey: id)
    return sessions.removeValue(forKey: id)
  }

  func allSessions() -> [SshSession] {
    lock.lock()
    defer { lock.unlock() }
    return Array(sessions.values)
  }

  func sessionRecords() -> [SessionInfoRecord] {
    lock.lock()
    defer { lock.unlock() }
    return sessions.keys.compactMap { sessionId in
      guard let target = targets[sessionId] else {
        return nil
      }
      var record = SessionInfoRecord()
      record.sessionId = sessionId
      record.appSessionId = target.appSessionId
      record.host = target.host
      record.port = target.port
      record.username = target.username
      record.shellIds = shells.filter { $0.value.sessionId == sessionId }.map(\.key)
      record.sftpIds = sftpSessions.filter { $0.value == sessionId }.map(\.key)
      record.forwardIds = forwards.filter { $0.value.sessionId == sessionId }.map(\.key)
      return record
    }
  }

  func store(shell: SshShellSource, id: String) {
    lock.lock()
    shells[id] = shell
    lock.unlock()
  }

  func removeShell(_ id: String) -> SshShellSource? {
    lock.lock()
    defer { lock.unlock() }
    return shells.removeValue(forKey: id)
  }

  func shellIds(of sessionId: String) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return shells.filter { $0.value.sessionId == sessionId }.map { $0.key }
  }

  func allShellIds() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return Array(shells.keys)
  }

  func store(sftp: SftpClient, id: String, sessionId: String) {
    lock.lock()
    sftpSessions[id] = sessionId
    sftps[id] = sftp
    lock.unlock()
  }

  func sftp(_ id: String) -> SftpClient? {
    lock.lock()
    defer { lock.unlock() }
    return sftps[id]
  }

  func removeSftp(_ id: String) -> SftpClient? {
    lock.lock()
    defer { lock.unlock() }
    sftpSessions.removeValue(forKey: id)
    return sftps.removeValue(forKey: id)
  }

  func allSftps() -> [SftpClient] {
    lock.lock()
    defer { lock.unlock() }
    return Array(sftps.values)
  }

  func store(forward: ForwardEntry, id: String) {
    lock.lock()
    forwards[id] = forward
    lock.unlock()
  }

  func removeForward(_ id: String) -> ForwardEntry? {
    lock.lock()
    defer { lock.unlock() }
    return forwards.removeValue(forKey: id)
  }

  func allForwards() -> [ForwardHandle] {
    lock.lock()
    defer { lock.unlock() }
    return forwards.values.map(\.handle)
  }

  func forwardRecords() -> [ForwardInfoRecord] {
    lock.lock()
    defer { lock.unlock() }
    return forwards.map { forwardId, entry in
      var record = ForwardInfoRecord()
      record.forwardId = forwardId
      record.sessionId = entry.sessionId
      record.direction = entry.direction
      record.bindHost = entry.bindHost
      record.bindPort = entry.bindPort
      record.port = entry.port
      return record
    }
  }

  func store(cancel: CancelToken, id: String) {
    lock.lock()
    cancels[id] = cancel
    lock.unlock()
  }

  func cancel(_ id: String) -> CancelToken? {
    lock.lock()
    defer { lock.unlock() }
    return cancels[id]
  }

  func removeCancel(_ id: String) -> CancelToken? {
    lock.lock()
    defer { lock.unlock() }
    return cancels.removeValue(forKey: id)
  }

  func allCancels() -> [CancelToken] {
    lock.lock()
    defer { lock.unlock() }
    return Array(cancels.values)
  }

  func store(hostKeyRequest: PendingRequest<Bool>, id: String) {
    lock.lock()
    hostKeyRequests[id] = hostKeyRequest
    lock.unlock()
  }

  func takeHostKeyRequest(_ id: String) -> PendingRequest<Bool>? {
    lock.lock()
    defer { lock.unlock() }
    return hostKeyRequests.removeValue(forKey: id)
  }

  func store(promptRequest: PendingRequest<PromptReply>, id: String) {
    lock.lock()
    promptRequests[id] = promptRequest
    lock.unlock()
  }

  func takePromptRequest(_ id: String) -> PendingRequest<PromptReply>? {
    lock.lock()
    defer { lock.unlock() }
    return promptRequests.removeValue(forKey: id)
  }
}
