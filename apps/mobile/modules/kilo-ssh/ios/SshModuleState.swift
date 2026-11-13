import Foundation

/// Module state shared by the JavaScript thread and the Rust callback threads.
final class SshModuleState: @unchecked Sendable {
  let sessionIds = IdSequence(prefix: "session-")
  let shellIds = IdSequence(prefix: "shell-")
  let sftpIds = IdSequence(prefix: "sftp-")
  let forwardIds = IdSequence(prefix: "forward-")
  let requestIds = IdSequence(prefix: "request-")

  private let lock = NSLock()
  private var sessions: [String: SshSession] = [:]
  private var shells: [String: SshShellSource] = [:]
  private var sftps: [String: SftpEntry] = [:]
  private var forwards: [String: ForwardEntry] = [:]
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

  func store(sftp: SftpClient, sessionId: String, id: String) {
    lock.lock()
    sftps[id] = SftpEntry(sessionId: sessionId, client: sftp)
    lock.unlock()
  }

  func sftp(_ id: String) -> SftpClient? {
    lock.lock()
    defer { lock.unlock() }
    return sftps[id]?.client
  }

  func removeSftp(_ id: String) -> SftpClient? {
    lock.lock()
    defer { lock.unlock() }
    return sftps.removeValue(forKey: id)?.client
  }

  func sftpIds(of sessionId: String) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return sftps.filter { $0.value.sessionId == sessionId }.map { $0.key }
  }

  func allSftps() -> [SftpClient] {
    lock.lock()
    defer { lock.unlock() }
    return sftps.values.map { $0.client }
  }

  func store(forward: ForwardHandle, sessionId: String, id: String) {
    lock.lock()
    forwards[id] = ForwardEntry(sessionId: sessionId, handle: forward)
    lock.unlock()
  }

  func removeForward(_ id: String) -> ForwardHandle? {
    lock.lock()
    defer { lock.unlock() }
    return forwards.removeValue(forKey: id)?.handle
  }

  func forwardIds(of sessionId: String) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return forwards.filter { $0.value.sessionId == sessionId }.map { $0.key }
  }

  func allForwards() -> [ForwardHandle] {
    lock.lock()
    defer { lock.unlock() }
    return forwards.values.map { $0.handle }
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

/// An SFTP client and the session whose disconnect it shares.
private struct SftpEntry {
  let sessionId: String
  let client: SftpClient
}

/// A port forward and the session whose disconnect it shares.
private struct ForwardEntry {
  let sessionId: String
  let handle: ForwardHandle
}
