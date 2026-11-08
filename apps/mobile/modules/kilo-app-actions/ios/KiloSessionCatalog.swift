import Foundation
import UIKit

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

  /// Whether the app lock is on, the interval it allows in the background, and
  /// the instant the app last left the foreground with it on.
  ///
  /// The lock's owner (`src/lib/app-unlock-context.tsx`) pushes the first two
  /// through `setSessionCatalogLock`; the store records the third itself, so no
  /// JavaScript has to run while the app is away.
  private static let lockEnabledKey = "kilo-app-actions-session-catalog-lock-enabled"
  private static let lockIntervalKey = "kilo-app-actions-session-catalog-lock-interval"
  private static let backgroundedAtKey = "kilo-app-actions-session-catalog-backgrounded-at"

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

  /// Whether this process has been told the app is showing unlocked content.
  ///
  /// It starts closed on every launch, so nothing has to wipe the store to keep
  /// a locked launch from answering.
  private static let visibility = SessionCatalogVisibility()

  /// The stored entries, oldest write first, capped and clean — or nothing
  /// while the app lock keeps them from the person holding the device.
  ///
  /// Every App Intents question goes through here, so this is the one place the
  /// lock has to hold: the entity queries answer Siri and Shortcuts from a
  /// process the lock surface does not cover.
  public static func entries() -> [KiloSessionCatalogEntry] {
    queue.sync {
      if isWithheld() {
        return []
      }
      return read()
    }
  }

  /// The stored sessions a caller already names, by identifier.
  ///
  /// A saved shortcut stores the identifier of the session it opens, and the
  /// system rebuilds the entity by asking for that identifier before the run
  /// starts — in a launch where no JavaScript and no unlock has happened yet.
  /// Withholding the whole list there would turn a working shortcut into an
  /// unsupported-value error, so the identifier still resolves. The title is
  /// what the lock protects, and a withheld answer carries none: the entity
  /// exists to open the session the person already chose.
  public static func entries(forIdentifiers identifiers: [String]) -> [KiloSessionCatalogEntry] {
    let wanted = Set(identifiers)
    return queue.sync {
      let withheld = isWithheld()
      return read()
        .filter { wanted.contains($0.id) }
        .map { withheld ? KiloSessionCatalogEntry(id: $0.id, title: "") : $0 }
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

  /// Takes the app lock's terms: whether it is on, and how long the app may
  /// stay in the background before the titles stop being readable.
  ///
  /// The lock surface only covers the foreground, and the App Intents answer
  /// from a process the lock surface never draws on, so the store keeps the
  /// window itself: it records the instant the app leaves the foreground and
  /// refuses to answer once `interval` has passed it. The caller is the lock's
  /// only owner, so its switch and interval cannot drift from the interval the
  /// app applies to its own surface; turning the lock off drops the window with
  /// it.
  static func setLock(enabled: Bool, interval: TimeInterval) {
    queue.sync {
      let defaults = UserDefaults.standard
      defaults.set(enabled, forKey: lockEnabledKey)
      defaults.set(interval, forKey: lockIntervalKey)
      if !enabled {
        defaults.removeObject(forKey: backgroundedAtKey)
      }
    }
    _ = observeApplicationLifecycle
  }

  /// Records whether this process knows it is showing unlocked content.
  ///
  /// Only the lock's owner can answer that, and it answers once the launch has
  /// read the preference and — with the lock on — once the person has passed
  /// it. The value is deliberately not persisted: a process that has not been
  /// told anything answers nothing while the lock is on, which is what covers
  /// the two windows an in-app clear cannot reach — a launch the system starts
  /// to answer an App Intent, and the read of the lock preference itself.
  ///
  /// While the lock is off, none of this applies: the store answers its stored
  /// titles, because there is nothing to keep from the person holding the
  /// device.
  static func setVisible(_ visible: Bool) {
    visibility.set(visible)
    if visible {
      // The app is in use, so no window is running.
      queue.sync {
        UserDefaults.standard.removeObject(forKey: backgroundedAtKey)
      }
    }
  }

  /// Whether the stored titles must stay out of every App Intents answer.
  ///
  /// Only called inside `queue`, so it never takes the queue itself.
  private static func isWithheld(now: Date = Date()) -> Bool {
    let defaults = UserDefaults.standard
    guard defaults.bool(forKey: lockEnabledKey) else {
      return false
    }
    guard visibility.isVisible else {
      return true
    }
    guard let backgroundedAt = defaults.object(forKey: backgroundedAtKey) as? Double else {
      return false
    }
    let interval = defaults.object(forKey: lockIntervalKey) as? Double ?? 0
    return now.timeIntervalSince1970 - backgroundedAt >= interval
  }

  /// Writes the instant the app left the foreground, while the lock is on.
  private static func recordBackgroundedAt() {
    queue.sync {
      let defaults = UserDefaults.standard
      guard defaults.bool(forKey: lockEnabledKey) else {
        return
      }
      defaults.set(Date().timeIntervalSince1970, forKey: backgroundedAtKey)
    }
  }

  /// Drops the window the moment the app is in the foreground again: from there
  /// the lock's owner decides, and it hides the titles whenever the app is not
  /// unlocked.
  private static func clearBackgroundedAt() {
    queue.sync {
      UserDefaults.standard.removeObject(forKey: backgroundedAtKey)
    }
  }

  /// Starts following the two edges of the window, once, on the first lock
  /// update. The observers are never removed: the store outlives every caller,
  /// and the notifications arrive on the thread that posts them, which is the
  /// main thread for both.
  private static let observeApplicationLifecycle: Void = {
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { _ in
      KiloSessionCatalogStore.recordBackgroundedAt()
    }
    center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { _ in
      KiloSessionCatalogStore.clearBackgroundedAt()
    }
  }()

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

/// Whether this process has been told the app is showing unlocked content.
///
/// A lock rather than the store's queue: it is read from the entity query and
/// written from the module's JavaScript call, and holding the store's queue
/// while a query reads it would put both on one line for no gain.
private final class SessionCatalogVisibility: @unchecked Sendable {
  private let lock = NSLock()
  private var visible = false

  var isVisible: Bool {
    lock.lock()
    defer { lock.unlock() }
    return visible
  }

  func set(_ next: Bool) {
    lock.lock()
    defer { lock.unlock() }
    visible = next
  }
}
