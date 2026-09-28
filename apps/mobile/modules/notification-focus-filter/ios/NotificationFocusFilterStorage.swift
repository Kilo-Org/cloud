import Foundation

/// The one place the per-Focus agent-progress choice is stored and read.
///
/// The value lives in the app group the widget already uses
/// (`group.com.kilocode.kiloapp`, see `app.config.ts`) so the Focus filter that
/// writes it, the Expo module that reads it for the foreground banner, and the
/// notification service extension that reads it for a background delivery can
/// never disagree about the key or the container.
///
/// This file is compiled into both the app (`NotificationFocusFilter.podspec`)
/// and the `NotificationServiceExtension` target (`withNotificationFocusFilter`
/// copies it beside the extension's own source).
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
