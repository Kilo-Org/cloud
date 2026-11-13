import Foundation

/// A shell channel as the terminal view sees it: bytes go straight from Rust
/// to the view, and input comes back the same way. Nothing crosses JavaScript.
final class SshShellSource: TerminalByteSource, @unchecked Sendable {
  let sessionId: String
  private let channel: ShellChannel
  private let delivery: SinkDelivery

  init(sessionId: String, channel: ShellChannel, delivery: SinkDelivery) {
    self.sessionId = sessionId
    self.channel = channel
    self.delivery = delivery
  }

  static func open(
    sessionId: String,
    session: SshSession,
    term: String,
    cols: Int,
    rows: Int
  ) async throws -> SshShellSource {
    let delivery = SinkDelivery()
    let channel = try await session.openShell(
      term: term,
      cols: UInt32(cols),
      rows: UInt32(rows),
      sink: delivery
    )

    return SshShellSource(sessionId: sessionId, channel: channel, delivery: delivery)
  }

  func write(_ bytes: Data) {
    do {
      try channel.write(bytes: bytes)
    } catch {
      delivery.onClosed(exitStatus: nil, error: message(for: error))
    }
  }

  func resize(cols: Int, rows: Int) {
    do {
      try channel.resize(cols: UInt32(cols), rows: UInt32(rows))
    } catch {
      delivery.onClosed(exitStatus: nil, error: message(for: error))
    }
  }

  func setSink(_ sink: TerminalSink?) {
    delivery.bind(sink)
  }

  func close() {
    try? channel.shutdown()
  }

  private func message(for error: Error) -> String {
    guard let sshError = error as? SshError else {
      return String(describing: error)
    }
    return sshError.detail
  }
}

/// Bridges the core's output callback to the view's sink.
final class SinkDelivery: ByteSink, @unchecked Sendable {
  private static let maxBufferedBytes = 64 * 1024

  private let lock = NSLock()
  private var sink: TerminalSink?
  private var buffering = true
  private var buffered: [Data] = []
  private var bufferedBytes = 0
  private var closeEvent: (exitStatus: Int?, error: String?)?

  func bind(_ next: TerminalSink?) {
    lock.lock()
    sink = next
    buffering = false
    let pending = buffered
    buffered = []
    bufferedBytes = 0
    let closed = closeEvent
    lock.unlock()

    guard let next else {
      return
    }

    pending.forEach { next.onData($0) }
    if let closed {
      next.onClosed(exitStatus: closed.exitStatus, error: closed.error)
    }
  }

  func onData(bytes: Data) {
    lock.lock()
    let target = sink
    if target == nil && buffering && bufferedBytes + bytes.count <= Self.maxBufferedBytes {
      buffered.append(bytes)
      bufferedBytes += bytes.count
    }
    lock.unlock()

    target?.onData(bytes)
  }

  func onClosed(exitStatus: UInt32?, error: String?) {
    let status = exitStatus.map { Int($0) }

    lock.lock()
    let target = sink
    closeEvent = (status, error)
    lock.unlock()

    target?.onClosed(exitStatus: status, error: error)
  }
}
