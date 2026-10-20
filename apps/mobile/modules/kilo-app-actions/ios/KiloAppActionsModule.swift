import ExpoModulesCore

@ExpoModule("KiloAppActions")
public final class KiloAppActionsModule: Module {
  @JS
  @JavaScriptActor
  func registerAppActionDispatcher(dispatcher: borrowing JavaScriptValue) throws -> [[String: String]] {
    guard let appContext, let runtime = try? appContext.runtime else {
      throw ActionDispatcherNotReadyException()
    }
    KiloAppActionBridge.shared.register(dispatcher: dispatcher, runtime: runtime)
    return KiloAppActionBridge.shared.drainParkedPayloads()
  }
}

/// The module was used without a live runtime, so nothing can be registered.
private final class ActionDispatcherNotReadyException: Exception, @unchecked Sendable {
  override var reason: String {
    "KiloAppActions needs a live JS runtime to register the action dispatcher."
  }
}
