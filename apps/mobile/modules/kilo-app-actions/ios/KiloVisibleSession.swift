import AppIntents
import UIKit

/// Publishes the session the app is showing, so Siri and Apple Intelligence can
/// resolve "this session" to the one on screen.
///
/// `NSUserActivity.appEntityIdentifier` is the association the system reads for
/// a person's on-screen content, and it exists from iOS 18.2. Below that
/// runtime the publisher does nothing at all: every existing action keeps
/// working, and the entity picker still offers the catalog. There is no
/// fallback, because the pre-18.2 runtimes have no API to publish on-screen
/// context with.
///
/// The activity is attached to the key window's root view controller, which is
/// the UIKit form of the association (`UIResponder.userActivity`); the app has
/// one visible session at a time, which is exactly the single-entity case the
/// property is for.
enum KiloVisibleSession {
  /// The one activity type this app publishes. It never leaves the device: the
  /// activity is not eligible for Handoff or search, so it is a context cue
  /// only.
  static let activityType = "ai.kilo.session.visible"

  /// Sets the on-screen entity, or clears it when the session is no longer
  /// visible. Runs on the main thread: the responder chain belongs to UIKit.
  @MainActor
  static func publish(_ sessionId: String?) {
    guard #available(iOS 18.2, *) else {
      return
    }
    guard let responder = rootViewController() else {
      return
    }
    let trimmed = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
    responder.userActivity?.invalidate()
    responder.userActivity = nil
    guard let trimmed, !trimmed.isEmpty else {
      return
    }
    let activity = NSUserActivity(activityType: activityType)
    activity.appEntityIdentifier = EntityIdentifier(
      for: KiloSessionEntity.self,
      identifier: trimmed
    )
    responder.userActivity = activity
    activity.becomeCurrent()
  }

  @MainActor
  private static func rootViewController() -> UIViewController? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }?
      .rootViewController
  }
}
