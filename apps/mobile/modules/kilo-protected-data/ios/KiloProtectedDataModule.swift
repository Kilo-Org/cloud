import ExpoModulesCore
import UIKit

/**
 * Whether protected data (the keychain) is available.
 *
 * Every SecureStore item is `WHEN_UNLOCKED*`, so while the device is locked the
 * keychain refuses each call with `errSecInteractionNotAllowed`. JS reads this
 * state before a keychain call and waits for `onProtectedDataChange` to resume
 * work after unlock.
 *
 * `UIApplication.isProtectedDataAvailable` is main-thread only, and the JS
 * read is synchronous on the JS thread. So the main thread records the state:
 * the app delegate subscriber at launch, and the protected-data notifications
 * after that. JS reads the recorded value.
 */
final class KiloProtectedDataState {
  private static let lock = NSLock()
  private static var available = true

  static var isAvailable: Bool {
    lock.withLock { available }
  }

  /** Records `value` and answers whether it changed. */
  @discardableResult
  static func record(_ value: Bool) -> Bool {
    lock.withLock {
      let changed = available != value
      available = value
      return changed
    }
  }
}

public final class KiloProtectedDataModule: Module {
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("KiloProtectedData")
    Events("onProtectedDataChange")

    Function("isProtectedDataAvailable") { () -> Bool in
      KiloProtectedDataState.isAvailable
    }

    OnCreate {
      let center = NotificationCenter.default
      self.observers = [
        center.addObserver(
          forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in self?.record(false) },
        center.addObserver(
          forName: UIApplication.protectedDataDidBecomeAvailableNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in self?.record(true) }
      ]
      // The state can change between launch and this module's creation, while
      // no observer was registered. Read it again on the main thread.
      DispatchQueue.main.async { [weak self] in
        self?.record(UIApplication.shared.isProtectedDataAvailable)
      }
    }

    OnDestroy {
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers.removeAll()
    }
  }

  private func record(_ available: Bool) {
    if KiloProtectedDataState.record(available) {
      sendEvent("onProtectedDataChange", ["available": available])
    }
  }
}
