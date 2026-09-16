import ExpoModulesCore

/// The Expo module the JS side names `KiloAppActions`.
///
/// It exists for one handshake: the JS action pipeline registers the dispatcher
/// that performs the four actions, and the native entry points (the App Intents
/// on this platform) reach it through `KiloAppActionBridge`. No action logic
/// lives here, and the bridge is a singleton rather than module state because
/// an App Intent can run before, or without, a module instance.
public final class KiloAppActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KiloAppActions")

    /// Registers the JS handler that runs an action payload and answers with
    /// the `AppActionResult`. The return value is the payloads that arrived
    /// before this call, so the pipeline can run them; on iOS it is always
    /// empty, because a native run waits for registration instead of parking.
    AsyncFunction("registerAppActionDispatcher") { (dispatcher: JavaScriptValue) throws -> [[String: String]] in
      // `AppContext.runtime` is a throwing property: it raises `RuntimeLost`
      // until the runtime exists, which is the same condition as the module
      // having no app context at all.
      guard let appContext = self.appContext, let runtime = try? appContext.runtime else {
        throw ActionDispatcherNotReadyException()
      }
      KiloAppActionBridge.shared.register(dispatcher: dispatcher, runtime: runtime)
      return KiloAppActionBridge.shared.drainParkedPayloads()
    }

    /// The bridge outlives the module (an App Intent reaches it before, or
    /// without, one), so the runtime's teardown has to drop what it registered:
    /// the mirror of the Android module's `OnDestroy` clear. A later run then
    /// waits for the replacement registration instead of executing on a dead
    /// runtime.
    OnDestroy {
      KiloAppActionBridge.shared.unregister()
    }
  }
}

/// The module was used without a live runtime, so nothing can be registered.
private final class ActionDispatcherNotReadyException: Exception, @unchecked Sendable {
  override var reason: String {
    "KiloAppActions needs a live JS runtime to register the action dispatcher."
  }
}
