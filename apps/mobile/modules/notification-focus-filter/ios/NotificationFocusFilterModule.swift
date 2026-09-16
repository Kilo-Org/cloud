import ExpoModulesCore

/// The JS boundary for the per-Focus choice `AgentProgressFocusFilter` stores.
///
/// Apple-only capability, declared as `platforms: ["apple"]` in
/// `expo-module.config.json`: `SetFocusFilterIntent` is what carries a per-app
/// choice into a Focus, and only iOS has it. Android's equivalent per-kind
/// control is the notification channel the system settings own, so
/// `src/lib/notification-focus-filter.ts` reads this module optionally and
/// Android keeps the allowed-by-default path.
///
/// `isAgentProgressAllowed` reads the shared app-group value on every call so a
/// Focus the user switches in System Settings takes effect on the next push,
/// with no cached native state to invalidate.
public final class NotificationFocusFilterModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NotificationFocusFilter")

    Function("isAgentProgressAllowed") { () -> Bool in
      NotificationFocusFilterStorage.isAgentProgressAllowed()
    }
  }
}
