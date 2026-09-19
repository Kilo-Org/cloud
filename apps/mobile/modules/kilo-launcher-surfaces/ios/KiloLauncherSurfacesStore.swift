import Foundation

/**
 * UserDefaults store shared by the Expo module and the app delegate subscriber.
 *
 * `pendingLaunchUrlKey` parks the Quick Action url of a cold start until JS reads
 * it: at `didFinishLaunching` the JS bridge is not up yet, so the subscriber can
 * only leave the value behind for `consumePendingLaunchUrl`.
 *
 * `payloadKey` holds the payload JS last published, so `clearDynamicSurfaces` can
 * rebuild the New agent action on the sign-out path without a fresh payload,
 * mirroring the Android `LauncherSurfacesStore`.
 */
enum KiloLauncherSurfacesStore {
  static let pendingLaunchUrlKey = "kilo_launcher_pending_url"

  private static let payloadKey = "kilo_launcher_surfaces_payload"

  static func cachePayload(_ payloadJson: String) {
    UserDefaults.standard.set(payloadJson, forKey: payloadKey)
  }

  static func cachedPayloadJson() -> String? {
    UserDefaults.standard.string(forKey: payloadKey)
  }

  static func storePendingLaunchUrl(_ url: String) {
    UserDefaults.standard.set(url, forKey: pendingLaunchUrlKey)
  }

  /**
   * Sign-out drop for the parked cold-start url. `consumePendingLaunchUrl` runs
   * on the signed-in mount, so a url parked for the account that is signing out
   * would otherwise outlive it and route the next account to the previous
   * account's session.
   */
  static func clearPendingLaunchUrl() {
    UserDefaults.standard.removeObject(forKey: pendingLaunchUrlKey)
  }

  /**
   * Reads the parked url without clearing it. The action callback uses this to
   * recognise the cold-start item UIKit delivers a second time; only
   * `consumePendingLaunchUrl` may drop the value, because it is the JS mount
   * that performs the tap.
   */
  static func pendingLaunchUrl() -> String? {
    UserDefaults.standard.string(forKey: pendingLaunchUrlKey)
  }

  /** Reads and clears the parked url, so a cold start is consumed exactly once. */
  static func consumePendingLaunchUrl() -> String? {
    let url = UserDefaults.standard.string(forKey: pendingLaunchUrlKey)
    UserDefaults.standard.removeObject(forKey: pendingLaunchUrlKey)
    return url
  }
}
