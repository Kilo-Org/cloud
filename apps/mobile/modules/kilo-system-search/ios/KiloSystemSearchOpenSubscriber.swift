import CoreSpotlight
import ExpoModulesCore
import UIKit

/// Delivers a Spotlight result tap to the app.
///
/// A cold launch runs this subscriber before JavaScript exists, so the tap is
/// written to `KiloSystemSearchStore.pendingRouteKey` (the durable slot the
/// module reads and clears) and only then announced to a running module. Both
/// paths therefore hand the JS side exactly one identifier.
///
/// The delivery is iOS's own: a Spotlight tap arrives as an `NSUserActivity` of
/// type `CSSearchableItemActionType` through the app delegate. Android has no
/// equivalent callback and delivers its app-search tap as the launch `Intent`
/// that `KiloSystemSearchModule.kt` handles, so there is no shared entry point
/// to move this to. Both write the same pending slot, consumed through the one
/// cross-platform surface `src/lib/native-system-search.ts`.
public final class KiloSystemSearchOpenSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard userActivity.activityType == CSSearchableItemActionType,
          let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
          !identifier.isEmpty else {
      return false
    }
    // Written under the same lock `consumePendingRoute` reads and clears
    // under, so a tap delivered while the module is reading the slot is either
    // returned or left for the next read, never deleted unresolved.
    let lock = KiloSystemSearchStore.pendingRouteLock
    lock.lock()
    UserDefaults.standard.set(identifier, forKey: KiloSystemSearchStore.pendingRouteKey)
    lock.unlock()
    NotificationCenter.default.post(name: KiloSystemSearchStore.openNotification, object: nil)
    return true
  }
}
