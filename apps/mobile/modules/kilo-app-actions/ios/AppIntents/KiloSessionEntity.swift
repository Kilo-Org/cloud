import AppIntents
internal import KiloAppActions

/// One session, in the shape Siri and Shortcuts resolve parameters with.
///
/// The entity is what turns the four string parameters into a picker: Shortcuts
/// draws `suggestedEntities()` as a list of titles, and Siri matches a spoken
/// title through `entities(matching:)` before the run starts. Nothing is
/// invented here — the catalog is written by
/// `src/lib/system-search-sync.ts` from the same cached session rows the
/// system-search index uses, and `KiloSessionCatalogStore` holds it.
///
/// The circled-1 "do not open an arbitrary session" rule lives in the two
/// queries: a title that names nothing resolves to no entity, which makes Siri
/// report it instead of opening a session, and a title that names several
/// resolves to every one of them, which makes the system ask. The run never
/// picks one of a set.
@available(iOS 17.0, *)
struct KiloSessionEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Session"
  static var defaultQuery = KiloSessionEntityQuery()

  let id: String
  let title: String

  init(entry: KiloSessionCatalogEntry) {
    self.id = entry.id
    self.title = entry.title
  }

  /// The title is user data, so it is looked up as a literal and falls back to
  /// itself: `LocalizedStringResource(stringLiteral:)` is the one initializer
  /// the metadata processor accepts for a value that is not compile-time copy.
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: LocalizedStringResource(stringLiteral: title))
  }
}

/// Answers the system's entity questions from the catalog the app published.
///
/// Both conformances are required for the two surfaces: `EntityQuery` supplies
/// the picker and the identity lookup for a saved shortcut, and
/// `EntityStringQuery` supplies the spoken-title lookup Siri uses. The app has
/// no server here on purpose — a query that reached the network would make
/// Shortcuts wait, and the cache already holds every session the app can open.
///
/// The two questions have different answers behind the app lock: listing and
/// title matching offer nothing while the lock withholds the catalog, and the
/// identity lookup still answers for the identifiers a stored shortcut names,
/// without their titles. A run the person already configured therefore opens
/// the session it names, and a lock that engages later still keeps every title
/// out of Siri's answers.
@available(iOS 17.0, *)
struct KiloSessionEntityQuery: EntityQuery, EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [KiloSessionEntity] {
    KiloSessionCatalogStore.entries(forIdentifiers: identifiers).map(KiloSessionEntity.init(entry:))
  }

  func suggestedEntities() async throws -> [KiloSessionEntity] {
    KiloSessionCatalogStore.entries().map(KiloSessionEntity.init(entry:))
  }

  /// Every session whose title matches `string`.
  ///
  /// An exact title wins over the looser containment match, so the common case
  /// — the person says the title Shortcuts showed them — resolves to one
  /// entity. Two sessions that share an exact title both come back, and the
  /// system asks which one to open. Streaming a single arbitrary match instead
  /// would open a session the person never named.
  func entities(matching string: String) async throws -> [KiloSessionEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      return try await suggestedEntities()
    }
    let entries = KiloSessionCatalogStore.entries()
    let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    let exact = entries.filter { $0.title.compare(query, options: options) == .orderedSame }
    let matches = exact.isEmpty
      ? entries.filter { $0.title.range(of: query, options: options) != nil }
      : exact
    return matches.map(KiloSessionEntity.init(entry:))
  }
}
