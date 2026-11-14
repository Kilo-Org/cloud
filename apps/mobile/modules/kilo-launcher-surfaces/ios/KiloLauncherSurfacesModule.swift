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
 * pipeline a notification tap uses. Only the actions JS publishes become
 * shortcuts, so "Needs input" disappears once nothing waits, and a payload
 * without the required New agent action never reaches the launcher or the cache.
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

  /**
   * Called by JS after sign-out: keep only the cached New agent action. An empty
   * list means no valid payload was ever cached.
   */
  private func clearDynamicSurfaces() {
    // The parked cold-start url belongs to the account that is leaving: its only
    // reader, `consumePendingLaunchUrl`, runs on the signed-in mount, so a url
    // left behind would route the next account to the previous account's
    // session. Drop it with the dynamic shortcuts it came from.
    KiloLauncherSurfacesStore.clearPendingLaunchUrl()
    let cached = KiloLauncherSurfacesStore.cachedPayloadJson().flatMap {
      KiloLauncherSurfacesPayload(json: $0)
    }
    setShortcutItems(cached.map { [$0.newAgentItem] } ?? [])
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

private extension KiloLauncherSurfacesPayload {

  /** One item per published action, in publish order. */
  var shortcutItems: [UIApplicationShortcutItem] {
    [newAgentItem, needsInputItem, openLastSessionItem].compactMap { $0 }
  }

  var newAgentItem: UIApplicationShortcutItem {
    shortcut(identifier: KiloLauncherSurfacesShortcut.newAgentType, action: newAgent)
  }

  private var needsInputItem: UIApplicationShortcutItem? {
    needsInput.map {
      shortcut(identifier: KiloLauncherSurfacesShortcut.needsInputType, action: $0)
    }
  }

  private var openLastSessionItem: UIApplicationShortcutItem? {
    openLastSession.map {
      shortcut(identifier: KiloLauncherSurfacesShortcut.openLastSessionType, action: $0)
    }
  }

  /**
   * The title is the label JS translated. The type is the action identifier, not
   * the url, so two actions opening the same session keep distinct types, and
   * the url rides in `userInfo` as the NSString the `NSSecureCoding` value type
   * accepts.
   */
  private func shortcut(
    identifier: String,
    action: LauncherSurfacesAction
  ) -> UIApplicationShortcutItem {
    UIApplicationShortcutItem(
      type: identifier,
      localizedTitle: action.label,
      localizedSubtitle: nil,
      icon: nil,
      userInfo: [KiloLauncherSurfacesShortcut.urlUserInfoKey: action.url as NSString]
    )
  }
}
