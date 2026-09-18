import CoreSpotlight
import ExpoModulesCore
import UniformTypeIdentifiers

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

  public func definition() -> ModuleDefinition {
    Name("KiloSystemSearch")
    Events("onSystemSearchOpen")

    AsyncFunction("applyUpdate") { (add: [SystemSearchRecord], removeIds: [String], promise: Promise) in
      self.apply(add: add, removeIds: removeIds, promise: promise)
    }

    // `CSSearchableIndex` cannot enumerate what it holds, so the module answers
    // from its own ledger of `id -> fingerprint`.
    AsyncFunction("indexedFingerprints") { () -> [String: String] in
      Self.ledger()
    }

    AsyncFunction("clear") { (promise: Promise) in
      self.clear(promise: promise)
    }

    // The record id last opened from a Spotlight result, or nil when there is
    // none. The JS side maps it to a route, so no id lookup lives here. Async so
    // both platforms hand JavaScript the same promise shape: the Android module
    // resolves the id against its index before answering.
    AsyncFunction("consumePendingRoute") { () -> String? in
      let defaults = UserDefaults.standard
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
    indexItems(items) { indexError in
      if let indexError {
        promise.reject(indexError)
        return
      }
      self.deleteItems(removeIds) { deleteError in
        if let deleteError {
          promise.reject(deleteError)
          return
        }
        // The ledger advances only after both index calls succeed, so a
        // rejection leaves the previous ledger intact for the caller to retry.
        Self.commitLedger(add: add, removeIds: removeIds)
        promise.resolve()
      }
    }
  }

  private func clear(promise: Promise) {
    index.deleteSearchableItems(withDomainIdentifiers: [KiloSystemSearchStore.domainIdentifier]) { error in
      if let error {
        promise.reject(error)
        return
      }
      UserDefaults.standard.removeObject(forKey: KiloSystemSearchStore.ledgerKey)
      promise.resolve()
    }
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
