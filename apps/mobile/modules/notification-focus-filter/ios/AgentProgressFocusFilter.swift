import AppIntents
import Foundation

/// The Focus filter iOS shows under Settings → Focus → <Focus> → Apps.
///
/// One parameter: whether agent-progress notifications are allowed while this
/// Focus is active. `perform()` stores the choice; two readers apply it —
/// the foreground notification handler in `src/lib/notifications.ts` (through
/// the Expo module in this pod) and, while the app is not in the foreground,
/// the `NotificationServiceExtension` target beside it. Notifications that need
/// the user's input are never affected — they break through the Focus on their
/// own, so the filter has nothing to say about them.
///
/// The literals below are localization keys. `LocalizedStringResource`,
/// `IntentDescription`, and `@Parameter(title:)` resolve a literal against the
/// app bundle's `Localizable.strings` — the default table — so each English
/// string here must have an entry with the same key in the per-language catalog
/// `plugins/withFocusFilterLocalizations.js` installs from
/// `plugins/focus-filter-copy.json`. The keys carry spaces, so the entries must
/// stay quoted; that plugin exists because Expo's own writer emits them bare.
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
