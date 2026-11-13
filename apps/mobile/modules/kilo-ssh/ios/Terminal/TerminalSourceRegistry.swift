import Foundation

/// Process-wide lookup from the `sourceId` prop to the `TerminalByteSource` that serves it.
///
/// Views subscribe while they are attached so a source registered after the view mounts still binds.
final class TerminalSourceRegistry {
  static let shared = TerminalSourceRegistry()

  private let lock = NSLock()
  private var sources: [String: TerminalByteSource] = [:]
  private var listeners: [UUID: () -> Void] = [:]

  func register(_ sourceId: String, _ source: TerminalByteSource) {
    lock.lock()
    sources[sourceId] = source
    lock.unlock()
    notifyListeners()
  }

  func unregister(_ sourceId: String) {
    lock.lock()
    sources.removeValue(forKey: sourceId)
    lock.unlock()
    notifyListeners()
  }

  func find(_ sourceId: String) -> TerminalByteSource? {
    lock.lock()
    defer { lock.unlock() }
    return sources[sourceId]
  }

  @discardableResult
  func addListener(_ listener: @escaping () -> Void) -> UUID {
    let token = UUID()
    lock.lock()
    listeners[token] = listener
    lock.unlock()
    return token
  }

  func removeListener(_ token: UUID) {
    lock.lock()
    listeners.removeValue(forKey: token)
    lock.unlock()
  }

  private func notifyListeners() {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        return
      }
      lock.lock()
      let listeners = Array(self.listeners.values)
      lock.unlock()
      for listener in listeners {
        listener()
      }
    }
  }
}
