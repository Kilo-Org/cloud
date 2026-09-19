import ExpoModulesCore

/// The JS boundary for the per-Focus choice `AgentProgressFocusFilter` stores.
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
