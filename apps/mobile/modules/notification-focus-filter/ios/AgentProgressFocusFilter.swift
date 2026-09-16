import AppIntents
import Foundation

/// The one place the per-Focus agent-progress choice is stored and read.
///
/// The value lives in the app group the widget already uses
/// (`group.com.kilocode.kiloapp`, see `app.config.ts`) so the Focus filter that
/// writes it and the Expo module that reads it can never disagree about the
/// key or the container.
enum NotificationFocusFilterStorage {
  static let appGroupIdentifier = "group.com.kilocode.kiloapp"

  /// `false` only while an active Focus excludes agent progress. The key is
  /// absent (the default) whenever progress is allowed, so an app that has
  /// never stored a choice — or one whose Focus filter has been cleared — reads
  /// as allowed.
  static let agentProgressAllowedKey = "agentProgressAllowedInFocus"

  /// The stored choice, or `true` (progress allowed) when nothing is stored.
  static func isAgentProgressAllowed() -> Bool {
    guard let store = UserDefaults(suiteName: appGroupIdentifier),
          store.object(forKey: agentProgressAllowedKey) != nil else {
      return true
    }
    return store.bool(forKey: agentProgressAllowedKey)
  }

  /// Persist the choice for the active Focus. A `nil` value is the system
  /// clearing the filter (Focus deactivation), which restores the default:
  /// agent progress allowed.
  static func store(agentProgress: Bool?) {
    guard let store = UserDefaults(suiteName: appGroupIdentifier) else {
      return
    }
    if let agentProgress {
      store.set(agentProgress, forKey: agentProgressAllowedKey)
    } else {
      store.removeObject(forKey: agentProgressAllowedKey)
    }
  }
}

/// The Focus filter iOS shows under Settings → Focus → <Focus> → Apps.
///
/// One parameter: whether agent-progress notifications are allowed while this
/// Focus is active. `perform()` stores the choice; the foreground notification
/// handler in `src/lib/notifications.ts` reads it through the Expo module in
/// this pod and suppresses a progress push the user excluded. Notifications
/// that need the user's input are never affected — they break through the
/// Focus on their own, so the filter has nothing to say about them.
@available(iOS 16.0, *)
struct AgentProgressFocusFilter: SetFocusFilterIntent {
  static var title: LocalizedStringResource = "Agent notifications"

  static var description = IntentDescription(
    "Keep notifications that need your input and silence agent progress for this Focus."
  )

  @Parameter(title: "Agent progress")
  var agentProgress: Bool?

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "Agent notifications")
  }

  func perform() async throws -> some IntentResult {
    NotificationFocusFilterStorage.store(agentProgress: agentProgress)
    return .result()
  }
}
