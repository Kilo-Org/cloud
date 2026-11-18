import ExpoModulesCore
import UIKit

/**
 * Records the protected-data state at launch, on the main thread, before JS
 * runs. A push or a background task can launch the app while the device is
 * locked, and the startup credential read must see that state.
 */
public final class KiloProtectedDataAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    KiloProtectedDataState.record(application.isProtectedDataAvailable)
    return true
  }
}
