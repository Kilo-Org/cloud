import Foundation

/// Process-local identifiers for sessions, shells and prompt requests.
final class IdSequence: @unchecked Sendable {
  private let lock = NSLock()
  private let prefix: String
  private var value: UInt64 = 0

  init(prefix: String) {
    self.prefix = prefix
  }

  func next() -> String {
    lock.lock()
    defer { lock.unlock() }
    value += 1
    return "\(prefix)\(value)"
  }
}

/// The answers a keyboard-interactive round can end with.
enum PromptReply: Sendable {
  case answers([String])
  case cancelled
}

/// One decision awaited across threads. The answer may arrive before the
/// waiter, so both orders resolve exactly once.
final class PendingRequest<Value>: @unchecked Sendable {
  private enum State {
    case idle
    case waiting(CheckedContinuation<Value, Never>)
    case resolved(Value)
  }

  private let lock = NSLock()
  private var state: State = .idle

  func wait() async -> Value {
    await withCheckedContinuation { continuation in
      lock.lock()
      switch state {
      case .resolved(let value):
        state = .idle
        lock.unlock()
        continuation.resume(returning: value)
      case .idle, .waiting:
        state = .waiting(continuation)
        lock.unlock()
      }
    }
  }

  /// Returns whether a waiter was pending.
  func resolve(_ value: Value) -> Bool {
    lock.lock()
    switch state {
    case .waiting(let continuation):
      state = .idle
      lock.unlock()
      continuation.resume(returning: value)
      return true
    case .idle, .resolved:
      state = .resolved(value)
      lock.unlock()
      return false
    }
  }
}
