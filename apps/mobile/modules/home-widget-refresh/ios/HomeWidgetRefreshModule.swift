import ExpoModulesCore
import WidgetKit
import Foundation

public class HomeWidgetRefreshModule: Module {
  private let operationLock = NSLock()
  private var operationEpoch = 0
  private var destroyed = false
  private var pendingClearEpoch: Int?

  private func performOperation(_ epoch: Int, _ body: () throws -> Void) rethrows -> Bool {
    operationLock.lock()
    defer { operationLock.unlock() }
    guard !destroyed, epoch > operationEpoch else { return false }
    operationEpoch = epoch
    // A newer configure supersedes any in-flight clear; teardown must not erase the new scope.
    pendingClearEpoch = nil
    try body()
    return true
  }

  private func currentOperationEpoch() -> Int {
    operationLock.lock()
    defer { operationLock.unlock() }
    return operationEpoch
  }

  /// Admits a clear and captures the still-stored credential for unregister before it is removed.
  private func admitClear(_ epoch: Int) -> (config: [String: Any]?, token: String?)? {
    operationLock.lock()
    defer { operationLock.unlock() }
    guard !destroyed, epoch > operationEpoch else { return nil }
    operationEpoch = epoch
    pendingClearEpoch = epoch
    // Without the app group there is no stored credential to unregister; the clear still completes.
    return HomeWidgetRefreshStore.locked {
      (HomeWidgetRefreshStore.context(), $0.string(forKey: "homeWidgetPushToken"))
    } ?? (nil, nil)
  }

  private func finishClear(_ epoch: Int) {
    operationLock.lock()
    defer { operationLock.unlock() }
    guard pendingClearEpoch == epoch else { return }
    pendingClearEpoch = nil
    // A newer configure supersedes this clear; it already replaced (and fenced) the old scope.
    guard !destroyed, operationEpoch == epoch else { return }
    HomeWidgetRefreshStore.clear()
  }
  public func definition() -> ModuleDefinition {
    Name("HomeWidgetRefresh")
    Function("getOperationEpoch") { self.currentOperationEpoch() }
    AsyncFunction("configure") { (payload: String) in
      // The payload crosses the bridge as JSON text: a null field (a Personal
      // scope's `organizationId`, a row without an approval key) makes Expo's
      // Swift argument conversion fail before this body runs.
      guard let config = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] else {
        throw NSError(domain: HomeWidgetRefreshStore.service, code: 2, userInfo: [NSLocalizedDescriptionKey: "Widget configuration is not JSON"])
      }
      guard let epoch = config["operationEpoch"] as? Int else {
        throw NSError(domain: HomeWidgetRefreshStore.service, code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing widget operation epoch"])
      }
      let applied = try self.performOperation(epoch) { try HomeWidgetRefreshStore.configure(config) }
      if applied { await HomeWidgetRefreshStore.registerStoredPushToken() }
    }
    AsyncFunction("clear") { (epoch: Int) in
      guard let captured = self.admitClear(epoch) else { return }
      if let config = captured.config, let token = captured.token {
        await HomeWidgetRefreshStore.unregisterPushToken(token, config: config)
      }
      self.finishClear(epoch)
    }
    AsyncFunction("setFixtureMode") { (enabled: Bool) in HomeWidgetRefreshStore.fixture(enabled) }
    AsyncFunction("setFixtureLocale") { (locale: String) in HomeWidgetRefreshStore.fixtureLocale(locale) }
    AsyncFunction("getData") { () -> [String: Any]? in
      HomeWidgetRefreshStore.locked { HomeWidgetRefreshStore.readJSON($0, "homeWidgetData") } ?? nil
    }
    AsyncFunction("getWidgetPushToken") { () -> String? in
      HomeWidgetRefreshStore.defaults?.string(forKey: "homeWidgetPushToken")
    }
    AsyncFunction("isCurrent") { (scope: String, epoch: Int, generation: String) -> Bool in
      HomeWidgetRefreshStore.locked {
        HomeWidgetRefreshStore.current($0, ["scopeKey": scope, "accountEpoch": epoch], generation)
      } ?? false
    }
    AsyncFunction("widgetsChanged") { WidgetCenter.shared.reloadTimelines(ofKind: HomeWidgetRefreshStore.widgetName) }
    OnDestroy {
      self.operationLock.lock()
      self.destroyed = true
      self.operationEpoch += 1
      let clearPending = self.pendingClearEpoch != nil
      self.pendingClearEpoch = nil
      self.operationLock.unlock()
      // An admitted sign-out clear must still complete when its unregister is interrupted by teardown.
      if clearPending { HomeWidgetRefreshStore.clear() }
    }
  }
}
