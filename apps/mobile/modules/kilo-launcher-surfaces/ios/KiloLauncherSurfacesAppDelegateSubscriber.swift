import ExpoModulesCore
import UIKit

/**
 * The cold-start and warm handoff for the Home Screen Quick Actions.
 *
 * A cold start reaches JS only after the bridge is up, so the launched shortcut
 * found in `launchOptions[.shortcutItem]` is parked in UserDefaults under the
 * same key `KiloLauncherSurfacesModule.consumePendingLaunchUrl` reads. A warm tap
 * can open its url straight away: the shortcut `type` IS the deep-link url, so it
 * re-enters the app through the same pipeline a notification tap uses.
 */
public final class KiloLauncherSurfacesAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
      KiloLauncherSurfacesStore.storePendingLaunchUrl(item.type)
    }
    return true
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let url = URL(string: shortcutItem.type) else {
      completionHandler(false)
      return
    }
    // Warm start: JS is up, so the url enters the deep-link pipeline now. This
    // path must not write UserDefaults — nothing has to be consumed later.
    application.open(url, options: [:], completionHandler: nil)
    completionHandler(true)
  }
}
