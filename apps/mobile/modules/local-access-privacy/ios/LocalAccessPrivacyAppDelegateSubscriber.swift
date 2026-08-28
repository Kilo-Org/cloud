import ExpoModulesCore
import UIKit

public final class LocalAccessPrivacyAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LocalAccessPrivacy.shared.install()
    return true
  }

  public func applicationWillResignActive(_ application: UIApplication) {
    // Expo forwards this synchronously. Never await JavaScript or an opacity animation.
    LocalAccessPrivacy.shared.applicationActive(false)
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    LocalAccessPrivacy.shared.applicationActive(false)
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    LocalAccessPrivacy.shared.applicationActive(true)
  }
}
