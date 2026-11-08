import ExpoModulesCore

@ExpoModule("KiloAppActions")
public final class KiloAppActionsModule: Module {
  @JS
  @JavaScriptActor
  func registerAppActionDispatcher(dispatcher: consuming JavaScriptValue) throws -> [[String: String]] {
    guard let appContext, let runtime = try? appContext.runtime else {
      throw ActionDispatcherNotReadyException()
    }
    KiloAppActionBridge.shared.register(dispatcher: dispatcher, runtime: runtime)
    return KiloAppActionBridge.shared.drainParkedPayloads()
  }

  /// Replaces the session entity catalog. True means the stored bytes changed,
  /// so the caller can tell a real update from a run that re-published the same
  /// titles.
  @JS
  func replaceSessionCatalog(entries: [KiloSessionCatalogRecord]) -> Bool {
    KiloSessionCatalogStore.replace(entries.map(\.entry))
  }

  /// Wipes the session entity catalog. True means there was something to wipe.
  @JS
  func clearSessionCatalog() -> Bool {
    KiloSessionCatalogStore.clear()
  }

  /// Takes the app lock's terms, so the entity queries stop answering while the
  /// app sits in the background past the interval the lock allows.
  ///
  /// The interval comes from the lock's own owner, so the store cannot drift
  /// from the interval the app applies to its surface. JavaScript counts in
  /// milliseconds; the store keeps seconds.
  @JS
  func setSessionCatalogLock(enabled: Bool, intervalMs: Double) {
    KiloSessionCatalogStore.setLock(enabled: enabled, interval: intervalMs / 1000)
  }

  /// Tells the catalog whether this launch is showing unlocked content.
  ///
  /// The store starts closed on every launch, so a launch the system starts to
  /// answer an App Intent cannot answer with titles the lock keeps from the
  /// person holding the device, and a saved shortcut still resolves the session
  /// it names once the app says it is unlocked.
  @JS
  func setSessionCatalogVisible(visible: Bool) {
    KiloSessionCatalogStore.setVisible(visible)
  }

  /// Publishes the session the app is showing, or clears it. `nil` means no
  /// session is visible.
  @JS
  func setVisibleSession(sessionId: String?) async throws {
    try await KiloVisibleSessionBridge.publish(sessionId)
  }
}

/// One catalog entry, in the shape `src/lib/app-actions/native-bridge.ts`
/// sends. Mirrors `KiloSessionCatalogEntry`, which owns the stored shape.
struct KiloSessionCatalogRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""

  var entry: KiloSessionCatalogEntry {
    KiloSessionCatalogEntry(id: id, title: title)
  }
}

/// The module was used without a live runtime, so nothing can be registered.
private final class ActionDispatcherNotReadyException: Exception, @unchecked Sendable {
  override var reason: String {
    "KiloAppActions needs a live JS runtime to register the action dispatcher."
  }
}
