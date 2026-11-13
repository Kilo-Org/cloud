import Foundation

/// Module state shared by the JavaScript thread and the Rust callback threads.
final class SshModuleState: @unchecked Sendable {
  let sessionIds = IdSequence(prefix: "session-")
  let shellIds = IdSequence(prefix: "shell-")
  let sftpIds = IdSequence(prefix: "sftp-")
  let forwardIds = IdSequence(prefix: "forward-")

  private let lock = NSLock()
  private var sessions: [String: SshSession] = [:]
  private var shells: [String: SshShellSource] = [:]
  private var sftps: [String: SftpClient] = [:]
  private var forwards: [String: ForwardHandle] = [:]
  private var cancels: [String: CancelToken] = [:]
  private var hostKeyRequests: [String: PendingRequest<Bool>] = [:]
  private var promptRequests: [String: PendingRequest<PromptReply>] = [:]

  func store(session: SshSession, id: String) {
    lock.lock()
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
    return sessions.removeValue(forKey: id)
  }

  func allSessions() -> [SshSession] {
    lock.lock()
    defer { lock.unlock() }
    return Array(sessions.values)
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

  func store(sftp: SftpClient, id: String) {
    lock.lock()
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
    return sftps.removeValue(forKey: id)
  }

  func allSftps() -> [SftpClient] {
    lock.lock()
    defer { lock.unlock() }
    return Array(sftps.values)
  }

  func store(forward: ForwardHandle, id: String) {
    lock.lock()
    forwards[id] = forward
    lock.unlock()
  }

  func removeForward(_ id: String) -> ForwardHandle? {
    lock.lock()
    defer { lock.unlock() }
    return forwards.removeValue(forKey: id)
  }

  func allForwards() -> [ForwardHandle] {
    lock.lock()
    defer { lock.unlock() }
    return Array(forwards.values)
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
