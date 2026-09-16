import Foundation
import UserNotifications

/// Applies the per-Focus agent-progress choice on the iOS delivery path the app
/// is not on.
///
/// The foreground notification handler in `src/lib/notifications.ts` sees a push
/// only while the app is in the foreground, so on its own the choice stored by
/// `AgentProgressFocusFilter` would hold for a foreground banner and not for a
/// background or killed-app delivery. iOS hands a `mutable-content` push to this
/// extension before it shows it, which is the one place the stored choice can
/// still be applied. The server attaches that flag to exactly the pushes this
/// extension may drop — see `iosMutableContentForPushData` in
/// `packages/notifications/src/push-presentation.ts`.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var request: UNNotificationRequest?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    self.request = request

    guard Self.shouldDropProgress(forPushUserInfo: request.content.userInfo) else {
      // Everything the user did not exclude is delivered untouched: this
      // extension only ever drops, it never rewrites copy or counts.
      contentHandler(request.content)
      return
    }

    // The delivered content carries no alert, so the system posts nothing
    // visible for this push. Only an extension failure re-delivers the
    // original (see `serviceExtensionTimeWillExpire`).
    contentHandler(UNMutableNotificationContent())
  }

  override func serviceExtensionTimeWillExpire() {
    // Never turn a timeout into a silent drop: the window closed before the
    // choice could be applied, so deliver the push as it arrived.
    if let contentHandler {
      contentHandler(request?.content ?? UNMutableNotificationContent())
    }
    contentHandler = nil
    request = nil
  }

  /// True only for an agent-progress push the active Focus excluded. Needs-input
  /// and every non-agent push are never dropped here.
  private static func shouldDropProgress(forPushUserInfo userInfo: [AnyHashable: Any]) -> Bool {
    guard agentKind(forPushUserInfo: userInfo) == .progress else {
      return false
    }
    return !NotificationFocusFilterStorage.isAgentProgressAllowed()
  }

  private enum AgentNotificationKind {
    case needsInput
    case progress
  }

  /// A Swift mirror of `agentNotificationKindForPushData` in
  /// `packages/notifications/src/push-presentation.ts`, limited to the pushes
  /// that can be shown as a banner. Keep the two in step: a push this extension
  /// misreads as progress would silence something the user asked to keep, and a
  /// real progress push read as needs-input would leak past the Focus.
  private static func agentKind(forPushUserInfo userInfo: [AnyHashable: Any]) -> AgentNotificationKind? {
    guard let type = pushField("type", in: userInfo) as? String else {
      return nil
    }
    switch type {
    case "cloud_agent_session":
      // The schema default is `status`; an omitted category is a status
      // update, not a question for the user.
      return pushField("category", in: userInfo) as? String == "attention" ? .needsInput : .progress
    case "chat.message":
      // A reply in the user's conversation is what the user answers.
      return .needsInput
    case "active_agents_glanceable":
      // A data-only wake for the widget / Live Activity, never a banner: the
      // filter governs what the user is shown, not whether the card updates.
      return nil
    default:
      return nil
    }
  }

  /// Expo merges a push's `data` object into the APNs payload, which is the
  /// same object `expo-notifications` exposes to JavaScript as
  /// `notification.request.content.data`; older Expo payloads nest it under
  /// `body`. Read both so the kind never depends on the payload shape.
  private static func pushField(_ key: String, in userInfo: [AnyHashable: Any]) -> Any? {
    if let value = userInfo[key] {
      return value
    }
    guard let body = userInfo["body"] as? [AnyHashable: Any] else {
      return nil
    }
    return body[key]
  }
}
