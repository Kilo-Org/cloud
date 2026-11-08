import Foundation

/// One session the App Intents entity catalog can offer.
///
/// The catalog is deliberately two fields wide: the id a run opens and the
/// title a person typed or the backend promoted. No transcript, no message
/// body, no credential and no path is stored — Siri and Shortcuts only ever
/// need to name a session, and the app resolves everything else from live data
/// when the run opens it.
public struct KiloSessionCatalogEntry: Codable, Equatable {
  public let id: String
  public let title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}

/// The on-device store behind the session entity catalog.
///
/// The JavaScript owner (`src/lib/system-search-sync.ts`) writes the whole list
/// on every run, so the store has no ledger and no diff: it replaces the list
/// and reports whether the bytes changed. A run that produced the same titles
/// therefore costs one comparison instead of a disk write.
///
/// Every mutation runs on one serial queue, so a replace and a clear can never
/// interleave and a clear always wins when it is last.
public enum KiloSessionCatalogStore {
  /// The one defaults key. Account scoping is not a namespace here: the
  /// JavaScript owner writes the current account's titles and clears the store
  /// at every account boundary, and the entity query only ever reads what the
  /// current account published.
  static let key = "kilo-app-actions-session-catalog"

  /// How many titles the catalog keeps.
  ///
  /// The collector is newest-first, so the cap drops the oldest sessions. A
  /// device that stores an unbounded history would otherwise grow the catalog
  /// with every session ever opened, and the Shortcuts picker would take
  /// longer to appear for no gain: the oldest titles are the least likely to be
  /// spoken. The JavaScript collector applies the same bound.
  static let maxEntries = 50

  /// Serializes every mutation with the write that follows it.
  private static let queue = DispatchQueue(label: "kilo-app-actions-session-catalog")

  /// The stored entries, oldest write first, capped and clean.
  public static func entries() -> [KiloSessionCatalogEntry] {
    queue.sync {
      read()
    }
  }

  /// Replaces the whole list. True means the stored bytes changed.
  @discardableResult
  static func replace(_ entries: [KiloSessionCatalogEntry]) -> Bool {
    let cleaned = cleaned(entries)
    return queue.sync {
      let encoded = encode(cleaned)
      if encoded == UserDefaults.standard.data(forKey: key) {
        return false
      }
      UserDefaults.standard.set(encoded, forKey: key)
      return true
    }
  }

  /// Wipes the list. True means there was something to wipe.
  @discardableResult
  static func clear() -> Bool {
    queue.sync {
      guard UserDefaults.standard.object(forKey: key) != nil else {
        return false
      }
      UserDefaults.standard.removeObject(forKey: key)
      return true
    }
  }

  /// The stored list, decoded. A missing or unreadable value is an empty
  /// catalog: a corrupt store must not break the query that answers Siri.
  private static func read() -> [KiloSessionCatalogEntry] {
    guard let data = UserDefaults.standard.data(forKey: key),
          let decoded = try? JSONDecoder().decode([KiloSessionCatalogEntry].self, from: data)
    else {
      return []
    }
    return cleaned(decoded)
  }

  private static func encode(_ entries: [KiloSessionCatalogEntry]) -> Data {
    // `replace` already cleaned the list, and the encoding of a value this
    // small cannot fail; an empty fallback would only be reached by a corrupt
    // in-memory value and would store an empty catalog, which the query reads
    // as "nothing to offer".
    (try? JSONEncoder().encode(entries)) ?? Data("[]".utf8)
  }

  /// Drops a blank id or title, dedupes by id keeping the first, and caps.
  ///
  /// The dedupe repeats in Swift so a store written by an older runtime, or
  /// read after a partial write, can never hand the query two entries with one
  /// id: Shortcuts keys a chosen value by that id.
  private static func cleaned(_ entries: [KiloSessionCatalogEntry]) -> [KiloSessionCatalogEntry] {
    var seen = Set<String>()
    var kept: [KiloSessionCatalogEntry] = []
    for entry in entries {
      let id = entry.id.trimmingCharacters(in: .whitespacesAndNewlines)
      let title = entry.title.trimmingCharacters(in: .whitespacesAndNewlines)
      if id.isEmpty || title.isEmpty || !seen.insert(id).inserted {
        continue
      }
      kept.append(KiloSessionCatalogEntry(id: id, title: title))
      if kept.count == maxEntries {
        break
      }
    }
    return kept
  }
}
