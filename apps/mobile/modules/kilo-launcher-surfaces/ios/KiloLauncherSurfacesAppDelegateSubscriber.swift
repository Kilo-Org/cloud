import ExpoModulesCore
import UIKit

/**
 * The cold-start and warm handoff for the Home Screen Quick Actions.
 *
 * A cold start reaches JS only after the bridge is up, so the launched shortcut
 * found in `launchOptions[.shortcutItem]` is parked in UserDefaults under the
 * same key `KiloLauncherSurfacesModule.consumePendingLaunchUrl` reads. A warm tap
 * can open its url straight away. The url is the shortcut's `userInfo` payload,
 * not its `type`: the type is a stable action identifier, so two actions opening
 * the same session stay two items. Either way the url re-enters the app through
 * the same pipeline a notification tap uses.
 *
 * UIKit also hands the launched item to `performActionFor`, so that callback
 * leaves a url that is still parked to the JS mount instead of opening it a
 * second time. Expo's subscriber manager discards a subscriber's launch return
 * value and answers `true` itself, so the parked url is the marker, not a
 * `false` return.
 */
public final class KiloLauncherSurfacesAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem,
       let url = item.launcherUrl {
      KiloLauncherSurfacesStore.storePendingLaunchUrl(url)
    }
    return true
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let rawUrl = shortcutItem.launcherUrl, let url = URL(string: rawUrl) else {
      completionHandler(false)
      return
    }
    // UIKit delivers the item a cold start was launched with through this
    // callback too, while that item's url is still parked for the JS mount. The
    // mount is the delivery the tap gets, so opening the url here as well is a
    // second navigation for one tap; drop the repeat. Only a warm tap, whose url
    // the mount has already consumed, reaches the open below.
    if KiloLauncherSurfacesStore.pendingLaunchUrl() == rawUrl {
      completionHandler(true)
      return
    }
    // Warm start: JS is up, so the url enters the deep-link pipeline now. This
    // path must not write UserDefaults — nothing has to be consumed later.
    application.open(url, options: [:], completionHandler: nil)
    completionHandler(true)
  }
}

private extension UIApplicationShortcutItem {
  /** The deep-link url this Quick Action carries, or nil for a foreign shortcut. */
  var launcherUrl: String? {
    userInfo?[KiloLauncherSurfacesShortcut.urlUserInfoKey] as? String
  }
}
