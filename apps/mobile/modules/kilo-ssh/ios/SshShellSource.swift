import Foundation

/// A shell channel as the terminal view sees it: bytes go straight from Rust to
/// the view, and input comes back the same way. Nothing crosses JavaScript.
final class SshShellSource: TerminalByteSource, @unchecked Sendable {
  let sessionId: String
  private let channel: ShellChannel
  private let delivery: SinkDelivery

  /// Set only after a sink received the exit; unbound closed shells remain attachable.
  var terminated: Bool {
    delivery.terminated
  }

  init(sessionId: String, channel: ShellChannel, delivery: SinkDelivery) {
    self.sessionId = sessionId
    self.channel = channel
    self.delivery = delivery
  }

  /// `onTerminated` runs once, on the thread that delivers the channel's exit,
  /// after the bound sink has seen the close. It must not block.
  static func open(
    sessionId: String,
    session: SshSession,
    term: String,
    cols: UInt32,
    rows: UInt32,
    onTerminated: @escaping @Sendable () -> Void
  ) async throws -> SshShellSource {
    let delivery = SinkDelivery(onTerminated: onTerminated)
    let channel = try await session.openShell(
      term: term,
      cols: cols,
      rows: rows,
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
    guard
      let cols = UInt32(exactly: cols),
      let rows = UInt32(exactly: rows),
      cols > 0,
      rows > 0
    else {
      return
    }

    do {
      try channel.resize(cols: cols, rows: rows)
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
  private let onTerminated: @Sendable () -> Void
  private var sink: TerminalSink?
  private var closeDelivered = false
  private var buffered: [Data] = []
  private var bufferedBytes = 0
  private var closeEvent: (exitStatus: Int?, error: String?)?

  init(onTerminated: @escaping @Sendable () -> Void) {
    self.onTerminated = onTerminated
  }

  /// Written under `lock` and read from the module, which owns the source.
  var terminated: Bool {
    lock.lock()
    defer { lock.unlock() }
    return closeDelivered
  }

  func bind(_ next: TerminalSink?) {
    guard let next else {
      lock.lock()
      sink = nil
      lock.unlock()
      return
    }
    lock.lock()
    sink = next
    let pending = buffered
    buffered = []
    bufferedBytes = 0
    let closed = closeEvent
    lock.unlock()

    pending.forEach { next.onData($0) }
    if let closed {
      next.onClosed(exitStatus: closed.exitStatus, error: closed.error)
      deliveredClose()
    }
  }

  func onData(bytes: Data) {
    lock.lock()
    let target = sink
    if target == nil && bufferedBytes + bytes.count <= Self.maxBufferedBytes {
      buffered.append(bytes)
      bufferedBytes += bytes.count
    }
    lock.unlock()

    target?.onData(bytes)
  }

  func onClosed(exitStatus: UInt32?, error: String?) {
    let status = exitStatus.map { Int($0) }

    lock.lock()
    guard closeEvent == nil else {
      lock.unlock()
      return
    }
    let target = sink
    closeEvent = (status, error)
    lock.unlock()

    if let target {
      target.onClosed(exitStatus: status, error: error)
      deliveredClose()
    }
  }

  private func deliveredClose() {
    lock.lock()
    let first = !closeDelivered
    closeDelivered = true
    lock.unlock()
    if first {
      onTerminated()
    }
  }
}
