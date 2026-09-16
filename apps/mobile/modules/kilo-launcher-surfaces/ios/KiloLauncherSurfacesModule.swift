import ExpoModulesCore
import UIKit

/**
 * The iOS half of the launcher surfaces: the Home Screen Quick Actions a long
 * press on the app icon shows.
 *
 * JS owns the urls, the translated labels and the decision of when an agent
 * waits; this module owns what the launcher shows. The shortcut `type` is a
 * stable per-action identifier and the deep-link url rides in `userInfo`, so
 * native holds no route mapping and a tap re-enters the app through the same
 * pipeline a notification tap uses. An action whose url is null is absent, which
 * is how "Needs input" disappears once nothing waits.
 *
 * iOS has no quick-settings tile; its twin is a Control Center control, which is
 * a separate request and deliberately not built here.
 */
public final class KiloLauncherSurfacesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KiloLauncherSurfaces")

    // Kept synchronous to match the fire-and-forget contract JS declares for
    // both of these (src/lib/native-launcher-surfaces.ts). `UIApplication` is
    // main-thread-only and expo-modules-core 57 offers `runOnQueue` on async
    // functions only, so the UIKit write hops to the main queue rather than
    // changing the JS-visible shape.
    Function("setSurfaces") { (payloadJson: String) in
      self.publish(payloadJson)
    }

    Function("clearDynamicSurfaces") {
      self.clearDynamicSurfaces()
    }

    // The cold-start handoff. Android has no such function: its shortcut and
    // tile intents arrive as deep links instead.
    Function("consumePendingLaunchUrl") { () -> String? in
      KiloLauncherSurfacesStore.consumePendingLaunchUrl()
    }
  }

  private func publish(_ payloadJson: String) {
    guard let surfaces = KiloLauncherSurfacesPayload(json: payloadJson) else {
      return
    }
    KiloLauncherSurfacesStore.cachePayload(payloadJson)
    setShortcutItems(surfaces.shortcutItems)
  }

  /** Called by JS after sign-out: keep only the cached New agent action. */
  private func clearDynamicSurfaces() {
    // The parked cold-start url belongs to the account that is leaving: its only
    // reader, `consumePendingLaunchUrl`, runs on the signed-in mount, so a url
    // left behind would route the next account to the previous account's
    // session. Drop it with the dynamic shortcuts it came from.
    KiloLauncherSurfacesStore.clearPendingLaunchUrl()
    let cached = KiloLauncherSurfacesStore.cachedPayloadJson().flatMap {
      KiloLauncherSurfacesPayload(json: $0)
    }
    setShortcutItems(cached?.newAgentItem.map { [$0] } ?? [])
  }

  private func setShortcutItems(_ items: [UIApplicationShortcutItem]) {
    DispatchQueue.main.async {
      UIApplication.shared.shortcutItems = items
    }
  }
}

/**
 * The Quick Action contract shared by the module and the app delegate subscriber.
 *
 * `type` cannot be the deep-link url: iOS requires a shortcut's type to be unique
 * across the app, and a session that is both the longest-waiting and the
 * last-opened one gives Needs input and Open last session the same url, so two of
 * the three actions would carry one type. The type is therefore a stable
 * per-action identifier and the url travels in `userInfo`.
 */
enum KiloLauncherSurfacesShortcut {
  static let newAgentType = "kilo.launcher.new-agent"
  static let needsInputType = "kilo.launcher.needs-input"
  static let openLastSessionType = "kilo.launcher.open-last-session"
  /** The `userInfo` key holding the deep-link url a Quick Action must open. */
  static let urlUserInfoKey = "kilo.launcher.url"
}

/**
 * The launcher surfaces payload frozen by the JS side. `newAgentUrl` and
 * `newAgentLabel` are always present; the other two actions are dynamic, and a
 * null or empty url means the action is absent and must not be offered.
 */
private struct KiloLauncherSurfacesPayload {
  let newAgentUrl: String?
  let newAgentLabel: String?
  let needsInputUrl: String?
  let needsInputLabel: String?
  let openLastSessionUrl: String?
  let openLastSessionLabel: String?

  init?(json: String) {
    guard let data = json.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let object = parsed as? [String: Any] else {
      return nil
    }
    newAgentUrl = payloadString(object, "newAgentUrl")
    newAgentLabel = payloadString(object, "newAgentLabel")
    needsInputUrl = payloadString(object, "needsInputUrl")
    needsInputLabel = payloadString(object, "needsInputLabel")
    openLastSessionUrl = payloadString(object, "openLastSessionUrl")
    openLastSessionLabel = payloadString(object, "openLastSessionLabel")
  }

  /** At most three items, in publish order. A null url omits its action. */
  var shortcutItems: [UIApplicationShortcutItem] {
    [newAgentItem, needsInputItem, openLastSessionItem].compactMap { $0 }
  }

  var newAgentItem: UIApplicationShortcutItem? {
    shortcut(
      identifier: KiloLauncherSurfacesShortcut.newAgentType,
      url: newAgentUrl,
      label: newAgentLabel
    )
  }

  private var needsInputItem: UIApplicationShortcutItem? {
    shortcut(
      identifier: KiloLauncherSurfacesShortcut.needsInputType,
      url: needsInputUrl,
      label: needsInputLabel
    )
  }

  private var openLastSessionItem: UIApplicationShortcutItem? {
    shortcut(
      identifier: KiloLauncherSurfacesShortcut.openLastSessionType,
      url: openLastSessionUrl,
      label: openLastSessionLabel
    )
  }

  /**
   * The title is the label JS translated; the url is only the fallback for a
   * missing label, never an English literal. The type is the action identifier,
   * not the url, so two actions opening the same session keep distinct types.
   */
  private func shortcut(
    identifier: String,
    url: String?,
    label: String?
  ) -> UIApplicationShortcutItem? {
    guard let url else {
      return nil
    }
    return UIApplicationShortcutItem(
      type: identifier,
      localizedTitle: label ?? url,
      localizedSubtitle: nil,
      icon: nil,
      // The url rides in `userInfo` as the NSString the `NSSecureCoding` value
      // type accepts, so two actions opening the same session keep distinct types.
      userInfo: [KiloLauncherSurfacesShortcut.urlUserInfoKey: url as NSString]
    )
  }
}

/** Reads a payload string, treating an explicit JSON null or an empty string as absent. */
private func payloadString(_ object: [String: Any], _ key: String) -> String? {
  guard let value = object[key] as? String, !value.isEmpty else {
    return nil
  }
  return value
}
