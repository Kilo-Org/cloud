import ExpoModulesCore
import UIKit

struct PrivacyGateAction: Record {
  @Field var id: String = ""
  @Field var label: String = ""
  @Field var enabled: Bool = false
}

struct PrivacyGate: Record {
  @Field var title: String = ""
  @Field var message: String = ""
  @Field var actions: [PrivacyGateAction] = []
}

// Expo synchronous Functions run on the caller's thread. Visibility changes finish on main before return.
func onPrivacyMain<T>(_ body: () -> T) -> T {
  if Thread.isMainThread { return body() }
  return DispatchQueue.main.sync(execute: body)
}

public final class LocalAccessPrivacyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalAccessPrivacy")
    Events("onVisibilityChange", "onGateAction")

    OnCreate {
      onPrivacyMain {
        LocalAccessPrivacy.shared.install()
        LocalAccessPrivacy.shared.emit = { [weak self] name, payload in
          self?.sendEvent(name, payload)
        }
      }
    }
    OnDestroy {
      onPrivacyMain {
        // A JavaScript reload is not proof that authenticated windows have unmounted.
        LocalAccessPrivacy.shared.cover()
        LocalAccessPrivacy.shared.emit = nil
      }
    }
    Function("arm") { onPrivacyMain { LocalAccessPrivacy.shared.arm() } }
    Function("disarm") { onPrivacyMain { LocalAccessPrivacy.shared.disarm() } }
    Function("cover") { onPrivacyMain { LocalAccessPrivacy.shared.cover() } }
    Function("getSnapshot") { onPrivacyMain { LocalAccessPrivacy.shared.snapshot() } }
    Function("publishVisibility") { (generation: Int) in
      onPrivacyMain { LocalAccessPrivacy.shared.publish(generation) }
    }
    Function("isForegroundAllowed") {
      onPrivacyMain { LocalAccessPrivacy.shared.foregroundAllowed() }
    }
    Function("setGate") { (generation: Int, gate: PrivacyGate?) in
      onPrivacyMain { LocalAccessPrivacy.shared.setGate(generation, gate: gate) }
    }
    AsyncFunction("announce") { (message: String, generation: Int, gate: Bool) -> Bool in
      // This is the final native delivery boundary, after the native queue wait.
      guard LocalAccessPrivacy.shared.admitsAnnouncement(generation, gate: gate) else { return false }
      UIAccessibility.post(notification: .announcement, argument: message)
      return true
    }.runOnQueue(.main)
  }
}
