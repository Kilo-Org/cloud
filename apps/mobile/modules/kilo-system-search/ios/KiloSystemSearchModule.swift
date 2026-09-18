import CoreSpotlight
import ExpoModulesCore
import Foundation
import UniformTypeIdentifiers

/// The iOS half of the system-search bridge.
///
/// iOS's own search index is CoreSpotlight (`CSSearchableIndex`); Android's is
/// AppSearch, and no API spans both stores. Each platform therefore binds the
/// store it has under the Expo module contract, and
/// `src/lib/native-system-search.ts` is the one surface both answer, so the
/// user-visible behaviour matches. There is no cross-platform index API to
/// share, which is why this file exists beside the Android module.
///
/// The serialization follows the same split: `NSLock` and a `DispatchQueue`
/// serialize the CoreSpotlight calls here where the Android module uses a
/// monitor and its module queue, and both guard the identical pending-route
/// slot.

/// Names shared by the module and the app delegate subscriber.
///
/// `pendingRouteKey` holds the identifier of the last Spotlight result the user
/// opened. The subscriber runs before JavaScript on a cold launch, so the slot
/// — not the event — is the durable source of truth: each delivery is consumed
/// exactly once by `consumePendingRoute`.
enum KiloSystemSearchStore {
  static let domainIdentifier = "kilo-system-search"
  static let ledgerKey = "kilo-system-search-indexed-fingerprints"
  static let pendingRouteKey = "kilo-system-search-pending-route"
  static let openNotification = Notification.Name("kilo-system-search-open")

  /// Guards the single-shot `pendingRouteKey` slot. The subscriber writes it on
  /// the main thread while the module reads and clears it on its own queue, so
  /// the get-then-remove must be atomic: a tap written between the two would be
  /// deleted without ever being returned and would never navigate.
  static let pendingRouteLock = NSLock()

  /// Serializes every index mutation with the ledger update that follows it, so
  /// an `applyUpdate` and a `clear` can never interleave. Without it a clear's
  /// ledger wipe can land after an apply's index calls but before its commit,
  /// leaving the ledger claiming records the index no longer holds.
  static let operationQueue = DispatchQueue(label: "kilo-system-search-operations")
}

/// One indexed entity. Mirrors `SystemSearchDocument` in `src/lib/native-system-search.ts`.
struct SystemSearchRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var description: String = ""
  @Field var keywords: [String] = []
  @Field var fingerprint: String = ""
}

public final class KiloSystemSearchModule: Module {
  private let index = CSSearchableIndex.default()
  private var openObserver: NSObjectProtocol?

  /// How long one index call may block the shared operation queue before its
  /// promise is rejected. `CSSearchableIndex` does not call its completion
  /// handler when the index is unavailable, and every apply and clear runs on
  /// the one serial queue, so the promise must not wait unbounded. A timeout
  /// rejects the promise but does NOT release the queue block: the operation
  /// keeps waiting for its late completion so a later mutation cannot be
  /// overtaken by it (see `waitForIndex`). Mirrors the Android module's
  /// `latch.await(TIMEOUT_SECONDS, …)`.
  private static let indexTimeout: DispatchTimeInterval = .seconds(30)
  private static let timeoutMessage = "The system search index did not respond."

  public func definition() -> ModuleDefinition {
    Name("KiloSystemSearch")
    Events("onSystemSearchOpen")

    // The apply and the clear run on one serial queue, and each blocks that
    // queue until the index answers; a timed-out call keeps the queue until its
    // late completion lands, so their index calls and their ledger updates can
    // never interleave — a sign-out clear cannot be overtaken by an earlier
    // late add or delete. The promise is resolved from the queue later; the
    // closure itself returns immediately.
    AsyncFunction("applyUpdate") { (add: [SystemSearchRecord], removeIds: [String], promise: Promise) in
      KiloSystemSearchStore.operationQueue.async {
        self.apply(add: add, removeIds: removeIds, promise: promise)
      }
    }

    // `CSSearchableIndex` cannot enumerate what it holds, so the module answers
    // from its own ledger of `id -> fingerprint`.
    AsyncFunction("indexedFingerprints") { () -> [String: String] in
      Self.ledger()
    }

    AsyncFunction("clear") { (promise: Promise) in
      KiloSystemSearchStore.operationQueue.async {
        self.clear(promise: promise)
      }
    }

    // The record id last opened from a Spotlight result, or nil when there is
    // none. The JS side maps it to a route, so no id lookup lives here. Async so
    // both platforms hand JavaScript the same promise shape: the Android module
    // resolves the id against its index before answering.
    AsyncFunction("consumePendingRoute") { () -> String? in
      let defaults = UserDefaults.standard
      // Get-and-clear under the same lock the subscriber writes under: a tap
      // written between the read and the remove would be lost forever.
      let lock = KiloSystemSearchStore.pendingRouteLock
      lock.lock()
      defer { lock.unlock() }
      guard let identifier = defaults.string(forKey: KiloSystemSearchStore.pendingRouteKey) else {
        return nil
      }
      defaults.removeObject(forKey: KiloSystemSearchStore.pendingRouteKey)
      return identifier
    }

    OnStartObserving {
      self.startForwardingOpenEvents()
    }
    OnStopObserving {
      self.stopForwardingOpenEvents()
    }
    // A module instance is destroyed without necessarily stopping observation
    // (a reload tears the bridge down), so the observer is released here too.
    OnDestroy {
      self.stopForwardingOpenEvents()
    }
  }

  private func apply(add: [SystemSearchRecord], removeIds: [String], promise: Promise) {
    let items = add.map(Self.searchableItem)
    let wait = DispatchSemaphore(value: 0)
    var indexError: Error?
    indexItems(items) { error in
      indexError = error
      wait.signal()
    }
    guard Self.waitForIndex(wait, promise: promise) else {
      return
    }
    if let indexError {
      promise.reject(indexError)
      return
    }
    var deleteError: Error?
    self.deleteItems(removeIds) { error in
      deleteError = error
      wait.signal()
    }
    guard Self.waitForIndex(wait, promise: promise) else {
      return
    }
    if let deleteError {
      promise.reject(deleteError)
      return
    }
    // The ledger advances only after both index calls succeed, so a rejection
    // leaves the previous ledger intact for the caller to retry. The serial
    // operation queue means no clear can have wiped the ledger in between.
    Self.commitLedger(add: add, removeIds: removeIds)
    promise.resolve()
  }

  private func clear(promise: Promise) {
    let wait = DispatchSemaphore(value: 0)
    var clearError: Error?
    index.deleteSearchableItems(
      withDomainIdentifiers: [KiloSystemSearchStore.domainIdentifier]
    ) { error in
      clearError = error
      wait.signal()
    }
    guard Self.waitForIndex(wait, promise: promise) else {
      return
    }
    if let clearError {
      promise.reject(clearError)
      return
    }
    UserDefaults.standard.removeObject(forKey: KiloSystemSearchStore.ledgerKey)
    promise.resolve()
  }

  /// Waits for one index call to answer, with the bound above, and returns false
  /// once the promise was rejected for a timeout.
  ///
  /// A timeout means the completion handler has not run yet; it does not mean
  /// the request is no longer in flight. `CSSearchableIndex` can still commit a
  /// timed-out add or delete after this queue block would otherwise return, and
  /// a later mutation would then race that late write — a sign-out clear could
  /// be overtaken by an earlier add. So a timeout rejects the promise but this
  /// operation stays on the serial queue until the native completion is
  /// observed, fencing every later mutation behind it. In the pathological case
  /// where the completion never runs, later mutations wait rather than
  /// interleave; that is strictly safer than letting their writes race.
  private static func waitForIndex(_ wait: DispatchSemaphore, promise: Promise) -> Bool {
    if wait.wait(timeout: .now() + indexTimeout) == .success {
      return true
    }
    promise.reject(indexTimeoutError())
    // Keep this operation on the queue until the still-in-flight call answers.
    // A signal that lands between the timeout and this wait is not lost: the
    // semaphore counts it and this wait returns immediately.
    wait.wait()
    return false
  }

  private static func indexTimeoutError() -> Exception {
    Exception(
      name: "ERR_SYSTEM_SEARCH_TIMEOUT",
      description: timeoutMessage,
      code: "ERR_SYSTEM_SEARCH_TIMEOUT"
    )
  }

  private func indexItems(_ items: [CSSearchableItem], completion: @escaping (Error?) -> Void) {
    guard !items.isEmpty else {
      completion(nil)
      return
    }
    index.indexSearchableItems(items, completionHandler: completion)
  }

  private func deleteItems(_ identifiers: [String], completion: @escaping (Error?) -> Void) {
    guard !identifiers.isEmpty else {
      completion(nil)
      return
    }
    index.deleteSearchableItems(withIdentifiers: identifiers, completionHandler: completion)
  }

  private func startForwardingOpenEvents() {
    guard openObserver == nil else {
      return
    }
    openObserver = NotificationCenter.default.addObserver(
      forName: KiloSystemSearchStore.openNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent("onSystemSearchOpen")
    }
  }

  private func stopForwardingOpenEvents() {
    if let openObserver {
      NotificationCenter.default.removeObserver(openObserver)
    }
    openObserver = nil
  }

  private static func searchableItem(for record: SystemSearchRecord) -> CSSearchableItem {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = record.title
    attributes.contentDescription = record.description
    attributes.keywords = record.keywords
    return CSSearchableItem(
      uniqueIdentifier: record.id,
      domainIdentifier: KiloSystemSearchStore.domainIdentifier,
      attributeSet: attributes
    )
  }

  private static func ledger() -> [String: String] {
    UserDefaults.standard.dictionary(forKey: KiloSystemSearchStore.ledgerKey) as? [String: String] ?? [:]
  }

  private static func commitLedger(add: [SystemSearchRecord], removeIds: [String]) {
    var ledger = Self.ledger()
    removeIds.forEach { ledger[$0] = nil }
    add.forEach { ledger[$0.id] = $0.fingerprint }
    UserDefaults.standard.set(ledger, forKey: KiloSystemSearchStore.ledgerKey)
  }
}
