import FileProvider
import UniformTypeIdentifiers

/**
 Read-only File Provider extension over the artifact mirror.

 The app process registers the domain (see
 `modules/artifacts-provider/ios/ArtifactsProviderModule.swift`) and writes the
 mirror (see `src/lib/artifacts/artifact-mirror.ts`): one folder per session
 under `artifacts/sessions/<sessionId>`, indexed by `artifacts/manifest.json` in
 the `group.com.kilocode.kiloapp` app group. This extension only reads that
 container, so the Files app shows what an agent produced with no Kilo app in
 front.

 `NSFileProviderExtension` is deprecated; `NSFileProviderReplicatedExtension` is
 the shape iOS drives for a non-UI provider.

 Read-only by contract: `createItem`, `modifyItem` and `deleteItem` refuse with
 `Self.writeRefused`, and no item declares a writing, deleting or renaming
 capability, so the Files app offers no write action.
 */
final class ArtifactsFileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
  private let mirror = ArtifactMirror()

  /**
   The refusal every write entry point returns.

   Foundation's `fileWriteNoPermission` is declared on every SDK this target
   builds against; there is no write to permit, and the capabilities below keep
   the system from asking in the first place.
   */
  private static var writeRefused: Error {
    CocoaError(.fileWriteNoPermission)
  }

  required init(domain: NSFileProviderDomain) {
    // The mirror lives in the shared app group, so the domain itself carries no
    // state this extension has to keep.
    super.init()
  }

  /**
   The app owns the domain; nothing here holds a system resource. The staged
   copies `fetchContents` handed to the system are this process's only
   temporary files, so teardown removes them instead of waiting for the reaper.
   */
  func invalidate() {
    try? FileManager.default.removeItem(at: Self.stagingRoot)
  }

  func item(
    for identifier: NSFileProviderItemIdentifier,
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    switch ArtifactItemIdentifier(identifier) {
    case .root:
      completionHandler(ArtifactItem.root, nil)
    case .session(let sessionId):
      guard let session = mirror.session(id: sessionId) else {
        completionHandler(nil, NSFileProviderError(.noSuchItem))
        return progress
      }
      completionHandler(ArtifactItem(session: session), nil)
    case .file(let sessionId, let fileId):
      guard let file = mirror.file(sessionId: sessionId, fileId: fileId) else {
        completionHandler(nil, NSFileProviderError(.noSuchItem))
        return progress
      }
      let modified = fileAttributes(sessionId: sessionId, fileId: fileId)?.modified
      completionHandler(
        ArtifactItem(
          file: file,
          sessionId: sessionId,
          filename: resolvedFilename(file: file, sessionId: sessionId),
          contentModificationDate: modified
        ),
        nil
      )
    case .unknown:
      completionHandler(nil, NSFileProviderError(.noSuchItem))
    }
    progress.completedUnitCount = 1
    return progress
  }

  func fetchContents(
    for itemIdentifier: NSFileProviderItemIdentifier,
    version requestedVersion: NSFileProviderItemVersion?,
    request: NSFileProviderRequest,
    completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    guard case .file(let sessionId, let fileId) = ArtifactItemIdentifier(itemIdentifier),
      let file = mirror.file(sessionId: sessionId, fileId: fileId),
      let source = mirror.fileURL(sessionId: sessionId, fileId: fileId),
      FileManager.default.fileExists(atPath: source.path)
    else {
      completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
      return progress
    }
    let attributes = mirror.fileAttributes(sessionId: sessionId, fileId: fileId)
    let modified = attributes?.modified
    let item = ArtifactItem(
      file: file,
      sessionId: sessionId,
      filename: resolvedFilename(file: file, sessionId: sessionId),
      contentModificationDate: modified
    )
    // The requested version is the system's pinned copy of this file: serving
    // different bytes against it would hand the Files app content that does
    // not match what it asked for, so a mismatch fails and the system
    // re-fetches the current state instead.
    if let requestedVersion, let current = item.itemVersion,
      requestedVersion.contentVersion.map({ Data($0.utf8) }) != current.map({ Data($0.utf8) })
    {
      completionHandler(nil, nil, NSError(
        domain: NSFileProviderErrorDomain,
        code: -2009, // NSFileProviderErrorVersionNoLongerAvailable, unavailable on iOS
        userInfo: nil
      ))
      return progress
    }
    do {
      let staged = try Self.stage(source: source, filename: item.filename)
      progress.completedUnitCount = 1
      completionHandler(staged, item, nil)
    } catch {
      completionHandler(nil, nil, error)
    }
    return progress
  }

  /**
   The safe, single-component filename this extension hands out for a manifest
   entry: sanitized, then deduplicated against the rest of the session's
   entries in the manifest's own order, exactly as enumeration resolves them,
   so the item's filename and the staged URL agree.
   */
  private func resolvedFilename(file: ArtifactManifest.File, sessionId: String) -> String {
    var taken = Set<String>()
    var resolved: String?
    for entry in mirror.session(id: sessionId)?.files ?? [] {
      let candidate = ArtifactFileName.unique(
        ArtifactFileName.sanitize(id: entry.id, name: entry.name, mime: entry.mime),
        taken: &taken
      )
      if entry.id == file.id {
        resolved = candidate
      }
    }
    return resolved ?? ArtifactFileName.sanitize(id: file.id, name: file.name, mime: file.mime)
  }

  func createItem(
    basedOn itemTemplate: NSFileProviderItem,
    fields: NSFileProviderItemFields,
    contents newContents: URL?,
    options: NSFileProviderCreateItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    completionHandler(nil, [], false, Self.writeRefused)
    return progress
  }

  func modifyItem(
    _ item: NSFileProviderItem,
    baseVersion version: NSFileProviderItemVersion,
    changedFields: NSFileProviderItemFields,
    contents newContents: URL?,
    options: NSFileProviderModifyItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    completionHandler(nil, [], false, Self.writeRefused)
    return progress
  }

  func deleteItem(
    identifier: NSFileProviderItemIdentifier,
    baseVersion version: NSFileProviderItemVersion,
    options: NSFileProviderDeleteItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    completionHandler(Self.writeRefused)
    return progress
  }

  func enumerator(
    for containerItemIdentifier: NSFileProviderItemIdentifier,
    request: NSFileProviderRequest
  ) throws -> NSFileProviderEnumerator {
    switch ArtifactItemIdentifier(containerItemIdentifier) {
    case .root:
      return ArtifactsEnumerator(container: .root)
    case .session(let sessionId):
      guard mirror.session(id: sessionId) != nil else {
        throw NSFileProviderError(.noSuchItem)
      }
      return ArtifactsEnumerator(container: .session(sessionId))
    case .file:
      throw NSFileProviderError(.noSuchItem)
    case .unknown:
      // The system asks for the working set and the trash on its own schedule;
      // this location has neither, so it enumerates nothing instead of failing.
      return ArtifactsEnumerator(container: .unknown)
    }
  }

  /**
   The system takes ownership of the URL it is handed and may move or delete
   it, so the mirrored bytes are copied out first: the mirror is read-only and
   has to survive a browse.

   Each fetch stages into its own subdirectory, because two fetches can be in
   flight at once and each hands its own URL to the system. A staged copy is
   temporary by construction: it is reaped once the system has had ample time
   to take it, so a browse cannot accumulate up to the per-file cap per open.
   */
  private static func stage(source: URL, filename: String) throws -> URL {
    precondition(ArtifactPath.isSafeComponent(filename), "staged name must be one path component")
    let root = Self.stagingRoot
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    reapStagedCopies(in: root)
    let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let destination = directory.appendingPathComponent(filename, isDirectory: false)
    try FileManager.default.copyItem(at: source, to: destination)
    return destination
  }

  /**
   Where staged copies wait for the system to take them.

   The extension keeps no app-group state, so its temporary copies live under
   the process's own temporary directory and never touch the mirror.
   */
  private static var stagingRoot: URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("ArtifactsFileProvider", isDirectory: true)
  }

  /**
   How long a staged copy may wait before the reaper removes it.

   The system takes a returned URL within moments of the completion handler, so
   this only bounds a copy the system never took, measured from the moment it
   was staged.
   */
  private static let stagedCopyLifetime: TimeInterval = 15 * 60

  /**
   Delete the staged copies the system has long since taken. Creation date is
   what ages a staging directory, so moving a copy out — which the system does
   when it takes one — cannot keep the directory alive.
   */
  private static func reapStagedCopies(in root: URL) {
    let manager = FileManager.default
    let cutoff = Date().addingTimeInterval(-Self.stagedCopyLifetime)
    let entries =
      (try? manager.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.creationDateKey]
      )) ?? []
    for entry in entries {
      let created =
        (try? entry.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
      if created < cutoff {
        try? manager.removeItem(at: entry)
      }
    }
  }
}

/**
 One manifest entry as a File Provider item.

 Read-only: the capabilities never include writing, deleting or renaming, so the
 Files app offers no write action for the location. A folder additionally
 declares `.allowsContentEnumerating`, which is what lets iOS enumerate a
 directory — without it a session folder shows but does not open.
 */
final class ArtifactItem: NSObject, NSFileProviderItem {
  let itemIdentifier: NSFileProviderItemIdentifier
  let parentItemIdentifier: NSFileProviderItemIdentifier
  let filename: String
  let contentType: UTType
  let documentSize: NSNumber?
  let contentModificationDate: Date?
  let itemVersion: String?
  let capabilities: NSFileProviderItemCapabilities

  /** The location's own root, which the Files app titles with the domain name. */
  static let root = ArtifactItem(
    itemIdentifier: .rootContainer,
    parentItemIdentifier: .rootContainer,
    filename: "Kilo",
    contentType: .folder,
    documentSize: nil,
    contentModificationDate: nil,
    itemVersion: nil,
    isDirectory: true
  )

  init(
    itemIdentifier: NSFileProviderItemIdentifier,
    parentItemIdentifier: NSFileProviderItemIdentifier,
    filename: String,
    contentType: UTType,
    documentSize: NSNumber?,
    contentModificationDate: Date?,
    itemVersion: String?,
    isDirectory: Bool
  ) {
    self.itemIdentifier = itemIdentifier
    self.parentItemIdentifier = parentItemIdentifier
    self.filename = filename
    self.contentType = contentType
    self.documentSize = documentSize
    self.contentModificationDate = contentModificationDate
    self.itemVersion = itemVersion
    // `.allowsReading` is the whole of it for a file. The root and a session
    // folder add `.allowsContentEnumerating`; nothing here ever adds a write
    // capability.
    self.capabilities =
      isDirectory ? [.allowsReading, .allowsContentEnumerating] : [.allowsReading]
    super.init()
  }

  /**
   A session folder; its name is the manifest label.

   The mirror writer sanitizes the title into one bounded, non-empty path
   component (`safeArtifactSessionName` in `src/lib/artifacts/artifact-mirror-manifest.ts`),
   which is exactly what `NSFileProviderItem.filename` requires and what Android's
   DocumentsProvider shows for the same folder — so it is taken as written here.
   */
  convenience init(session: ArtifactManifest.Session) {
    self.init(
      itemIdentifier: ArtifactItemIdentifier.encodeSession(session.id),
      parentItemIdentifier: .rootContainer,
      filename: session.title,
      contentType: .folder,
      documentSize: nil,
      contentModificationDate: nil,
      itemVersion: nil,
      isDirectory: true
    )
  }

  /**
   A mirrored file, typed from its manifest MIME type.

   `filename` is the safe single-component name the session resolved (see
   `ArtifactFileName`), never the raw manifest name, and the version fields
   carry the mirror file's own identity so the system can detect a rewrite.
   */
  convenience init(
    file: ArtifactManifest.File,
    sessionId: String,
    filename: String,
    contentModificationDate: Date?
  ) {
    self.init(
      itemIdentifier: ArtifactItemIdentifier.encodeFile(file.id, inSession: sessionId),
      parentItemIdentifier: ArtifactItemIdentifier.encodeSession(sessionId),
      filename: filename,
      contentType: UTType(mimeType: file.mime) ?? .data,
      documentSize: NSNumber(value: file.size),
      contentModificationDate: contentModificationDate,
      itemVersion: ArtifactItem.contentVersion(size: file.size, modified: contentModificationDate),
      isDirectory: false
    )
  }

  /**
   The content version of a mirrored file: its size and modification date.
   The mirror writer replaces a file wholesale, so both change with every
   rewrite; an equal pair means the bytes are unchanged.
   */
  static func contentVersion(size: Int, modified: Date?) -> String? {
    guard let modified else {
      return nil
    }
    return "size:\(size) modified:\(modified.timeIntervalSince1970)"
  }
}

/**
 Enumerates one container from the manifest.

 The mirror has no change log, so a change request reports the sync anchor as
 expired: the system discards the anchor and re-enumerates the container from
 scratch, which is exactly what the app's `signalEnumerator(for: .rootContainer)`
 asks for after a sync. An empty container is an empty enumeration, so a session
 with no artifacts is an empty folder in the Files app, never an error.
 */
final class ArtifactsEnumerator: NSObject, NSFileProviderEnumerator {
  private let mirror = ArtifactMirror()
  private let container: ArtifactItemIdentifier

  init(container: ArtifactItemIdentifier) {
    self.container = container
    super.init()
  }

  func invalidate() {}

  func enumerateItems(
    for observer: NSFileProviderEnumerationObserver,
    startingAt page: NSFileProviderPage
  ) {
    observer.didEnumerate(mirror.items(in: container))
    observer.finishEnumerating(upTo: nil)
  }

  func enumerateChanges(
    for observer: NSFileProviderChangeObserver,
    from anchor: NSFileProviderSyncAnchor
  ) {
    // `syncAnchorExpired` is what tells the system to discard the anchor it
    // holds and re-enumerate; `pageExpired` only expires an enumeration page
    // and would leave the system asking for changes from the same anchor.
    observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
  }
}

/**
 The mirror the app writes, read through the shared app group.

 Layout and keys mirror `src/lib/artifacts/artifact-mirror.ts` and
 `artifact-mirror-manifest.ts`: `artifacts/manifest.json` plus
 `artifacts/sessions/<sessionId>/<fileId>`. Move the three together.

 A reference type because the decoded index outlives one lookup: every lookup
 funnels through `manifest()`, and the system asks for one item at a time, so a
 session folder with N files would otherwise read and decode the whole index up
 to N times on the extension's main thread. The decode is memoized against the
 index file's own modification date and size, which change with every rewrite.

 Reading the shared app group is the capability iOS has and Android does not:
 Android has no app group. Android's counterpart,
 `ArtifactsDocumentsProvider.kt` (`modules/artifacts-provider`), serves the same
 index in-process from `filesDir` and memoizes the same decode on the same
 modification-date-and-size stamp, so one browse costs one parse on either
 platform.
 */
final class ArtifactMirror: @unchecked Sendable {
  /** App group shared with the app; must match the entitlement. */
  static let appGroupIdentifier = "group.com.kilocode.kiloapp"
  static let directoryName = "artifacts"
  static let sessionsDirectoryName = "sessions"
  static let manifestFileName = "manifest.json"
  static let supportedManifestVersion = 1

  /**
   The identity of the manifest file a cache entry was read from.

   The app rewrites the index wholesale (`.part` + rename), so the modification
   date and size together change whenever the content does: an equal stamp means
   the cached decode is still the file on disk.
   */
  private struct ManifestStamp: Equatable {
    let modified: Date?
    let size: Int?
  }

  private let lock = NSLock()
  private var cachedManifest: ArtifactManifest?
  private var cachedStamp: ManifestStamp?

  /**
   The manifest, or nil when there is none (signed out, or a first run that has
   not mirrored yet). An unreadable or unknown-version index reads as absent:
   the mirror is derived data, so a reader shows nothing rather than failing.

   The decoded index is memoized on the stamp of the file it was read from. A
   cache hit needs a stamp of its own, so an absent file — which has none — can
   never compare equal to the stamp a decode was stored under. Every path that
   does not end in a manifest that passed the version gate clears the entry, so
   a first run that has not mirrored yet never pins an empty location, and no
   decode is ever served for a file nothing backs.
   */
  func manifest() -> ArtifactManifest? {
    lock.lock()
    defer { lock.unlock() }
    guard let url = Self.manifestURL() else {
      cachedManifest = nil
      cachedStamp = nil
      return nil
    }
    let stamp = Self.stamp(of: url)
    if let cached = cachedManifest, let stamp, cachedStamp == stamp {
      return cached
    }
    guard let data = try? Data(contentsOf: url),
      let manifest = try? JSONDecoder().decode(ArtifactManifest.self, from: data),
      manifest.version == Self.supportedManifestVersion
    else {
      cachedManifest = nil
      cachedStamp = nil
      return nil
    }
    cachedManifest = manifest
    cachedStamp = stamp
    return manifest
  }

  func session(id: String) -> ArtifactManifest.Session? {
    manifest()?.sessions.first { $0.id == id }
  }

  func file(sessionId: String, fileId: String) -> ArtifactManifest.File? {
    session(id: sessionId)?.files.first { $0.id == fileId }
  }

  /** The bytes a manifest entry addresses, or nil when they are not on disk. */
  func fileURL(sessionId: String, fileId: String) -> URL? {
    guard ArtifactPath.isSafePath(sessionId: sessionId, fileId: fileId),
      let root = Self.rootURL()
    else {
      return nil
    }
    var url = root
      .appendingPathComponent(Self.sessionsDirectoryName, isDirectory: true)
      .appendingPathComponent(sessionId, isDirectory: true)
    for segment in fileId.split(separator: "/") {
      url.appendPathComponent(String(segment), isDirectory: false)
    }
    return url
  }

  /** What one enumerated container holds, in the manifest's own order. */
  func items(in container: ArtifactItemIdentifier) -> [ArtifactItem] {
    switch container {
    case .root:
      return (manifest()?.sessions ?? []).map { ArtifactItem(session: $0) }
    case .session(let sessionId):
      guard let session = session(id: sessionId) else {
        return []
      }
      // Names are sanitized and deduplicated here, so the item the
      // enumeration hands out and the URL `fetchContents` stages agree on one
      // safe filename per entry.
      var taken = Set<String>()
      return session.files.map { file in
        let name = ArtifactFileName.unique(
          ArtifactFileName.sanitize(id: file.id, name: file.name, mime: file.mime),
          taken: &taken
        )
        let modified = fileAttributes(sessionId: sessionId, fileId: file.id)?.modified
        return ArtifactItem(
          file: file,
          sessionId: sessionId,
          filename: name,
          contentModificationDate: modified
        )
      }
    case .file, .unknown:
      return []
    }
  }

  /**
   The mirror file's size and modification date, or nil when the file is not
   on disk or its attributes cannot be read. The version fields and the
   Files-app timestamp both come from this.
   */
  func fileAttributes(sessionId: String, fileId: String) -> (size: Int?, modified: Date?)? {
    guard let url = fileURL(sessionId: sessionId, fileId: fileId),
      let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
    else {
      return nil
    }
    return (values.fileSize, values.contentModificationDate)
  }

  private static func rootURL() -> URL? {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      )
    else {
      return nil
    }
    return container.appendingPathComponent(directoryName, isDirectory: true)
  }

  private static func manifestURL() -> URL? {
    rootURL()?.appendingPathComponent(manifestFileName, isDirectory: false)
  }

  /**
   The stamp of the manifest file, or nil when it cannot be read — including
   when it is not there, which is the signed-out and first-run case.
   */
  private static func stamp(of url: URL) -> ManifestStamp? {
    guard
      let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
    else {
      return nil
    }
    return ManifestStamp(modified: values.contentModificationDate, size: values.fileSize)
  }
}

/** The manifest `artifact-mirror-manifest.ts` writes. Unknown keys are ignored. */
struct ArtifactManifest: Decodable {
  struct File: Decodable {
    let id: String
    let name: String
    let mime: String
    let size: Int
  }

  struct Session: Decodable {
    let id: String
    let title: String
    let files: [File]
  }

  let version: Int
  let sessions: [Session]
}

/**
 The item identifiers this extension hands out, and parses back.

 The root is the system's `.rootContainer`, a session is `session:<id>`, and a
 file is `file:<sessionId>/<fileId>`. The ids come from the manifest, so parsing
 never trusts them: a component that is not a plain path segment is rejected
 where it would become a file path or an item identifier.
 */
enum ArtifactItemIdentifier {
  case root
  case session(String)
  case file(sessionId: String, fileId: String)
  case unknown

  static let sessionPrefix = "session:"
  static let filePrefix = "file:"

  init(_ identifier: NSFileProviderItemIdentifier) {
    let raw = identifier.rawValue
    if identifier == .rootContainer {
      self = .root
      return
    }
    if raw.hasPrefix(Self.sessionPrefix) {
      let sessionId = String(raw.dropFirst(Self.sessionPrefix.count))
      self = ArtifactPath.isSafeComponent(sessionId) ? .session(sessionId) : .unknown
      return
    }
    if raw.hasPrefix(Self.filePrefix) {
      let rest = raw.dropFirst(Self.filePrefix.count)
      guard let separator = rest.firstIndex(of: "/") else {
        self = .unknown
        return
      }
      let sessionId = String(rest[rest.startIndex..<separator])
      let fileId = String(rest[rest.index(after: separator)...])
      if ArtifactPath.isSafePath(sessionId: sessionId, fileId: fileId) {
        self = .file(sessionId: sessionId, fileId: fileId)
      } else {
        self = .unknown
      }
      return
    }
    self = .unknown
  }

  static func encodeSession(_ sessionId: String) -> NSFileProviderItemIdentifier {
    NSFileProviderItemIdentifier(rawValue: sessionPrefix + sessionId)
  }

  static func encodeFile(
    _ fileId: String,
    inSession sessionId: String
  ) -> NSFileProviderItemIdentifier {
    NSFileProviderItemIdentifier(rawValue: filePrefix + sessionId + "/" + fileId)
  }
}

/** Manifest ids become path components, so they are validated before either use. */
enum ArtifactPath {
  /** A session id is one folder name, never a path. */
  static func isSafeComponent(_ segment: String) -> Bool {
    !segment.isEmpty && segment != "." && segment != ".."
      && !segment.contains("/") && !segment.contains("\0")
  }

  /** A file id is one or more plain segments below the session folder. */
  static func isSafePath(sessionId: String, fileId: String) -> Bool {
    guard isSafeComponent(sessionId) else {
      return false
    }
    let segments = fileId.split(separator: "/", omittingEmptySubsequences: false)
    return !segments.isEmpty && segments.allSatisfy { isSafeComponent(String($0)) }
  }
}

/**
 Manifest file names become item filenames and staging path components, so
 they are sanitized and disambiguated before either use — the same contract
 `safeArtifactDisplayName` and `uniqueArtifactDisplayNames` give the manifest
 the mirror writer writes, mirrored here so the extension cannot be undone by
 a stale or older index.
 */
enum ArtifactFileName {
  /** The longest display name this extension hands out, in UTF-8 bytes. */
  static let maxBytes = 200
  /** Stem used when a name has nothing usable in it at all. */
  static let fallbackStem = "artifact"
  /** Extension used when the MIME type yields no usable extension. */
  static let fallbackExtension = "bin"

  /**
   One safe, single-component filename for a manifest entry: the basename
   without directory components and control characters, `.` and `..`
   rejected, falling back to the file id and then a fixed stem, and bounded to
   `maxBytes`. Mirrors the mirror writer's `sanitizeArtifactName` +
   `boundArtifactDisplayName`.
   */
  static func sanitize(id: String, name: String, mime: String) -> String {
    let fromName = sanitizeName(name)
    if !fromName.isEmpty {
      return fromName
    }
    let fromId = sanitizeName("\(id).\(extensionForMime(mime))")
    if !fromId.isEmpty {
      return fromId
    }
    let extension_ = sanitizeName(extensionForMime(mime))
    return extension_.isEmpty
      ? "\(fallbackStem).\(fallbackExtension)"
      : "\(fallbackStem).\(extension_)"
  }

  /**
   The first of `candidates` that is not taken yet, or the input when it is
   free. A collision takes a counter suffix before the extension, mirroring
   `uniqueArtifactDisplayNames`, so two entries that share a name never
   produce two items with the same filename in one parent.
   */
  static func unique(_ name: String, taken: inout Set<String>) -> String {
    guard taken.contains(name) else {
      taken.insert(name)
      return name
    }
    let (stem, extension_) = splitExtension(name)
    for index in 2...taken.count + 2 {
      let candidate = "\(stem) (\(index))\(extension_)"
      if !taken.contains(candidate) {
        taken.insert(candidate)
        return candidate
      }
    }
    return name
  }

  /** One sanitized basename, or an empty string when nothing survives. */
  private static func sanitizeName(_ raw: String) -> String {
    let basename = raw[raw.lastIndex(of: "/").map { raw.index(after: $0) } ?? raw.startIndex...]
    var withoutControls = ""
    for character in basename {
      if let scalar = character.unicodeScalars.first,
        !isControlScalar(scalar.value)
      {
        withoutControls.unicodeScalars.append(scalar)
      }
    }
    let collapsed = withoutControls
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
    if collapsed.isEmpty || collapsed == "." || collapsed == ".." {
      return ""
    }
    return bound(collapsed)
  }

  private static func isControlScalar(_ value: UInt32) -> Bool {
    value <= 31 || value == 127 || (128...159).contains(value)
  }

  private static func splitExtension(_ name: String) -> (stem: String, extension_: String) {
    guard let start = name.lastIndex(of: "."), start != name.startIndex,
      start < name.index(before: name.endIndex)
    else {
      return (name, "")
    }
    return (String(name[..<start]), String(name[start...]))
  }

  private static func bound(_ name: String) -> String {
    guard name.utf8.count > maxBytes else {
      return name
    }
    if let start = name.lastIndex(of: "."), start != name.startIndex,
      start < name.index(before: name.endIndex)
    {
      let extension_ = String(name[start...])
      if extension_.utf8.count < maxBytes {
        let stemBudget = maxBytes - extension_.utf8.count
        let stem = truncateUtf8(String(name[..<start]), stemBudget)
        if !stem.isEmpty {
          return stem + extension_
        }
      }
    }
    return truncateUtf8(name, maxBytes)
  }

  /**
   Trim a string to at most `maxBytes` UTF-8 bytes without splitting a
   character, mirroring `truncateUtf8` in the mirror writer.
   */
  private static func truncateUtf8(_ raw: String, _ maxBytes: Int) -> String {
    guard raw.utf8.count > maxBytes else {
      return raw
    }
    var result = ""
    var used = 0
    for character in raw {
      let bytes = character.utf8.count
      if used + bytes > maxBytes {
        break
      }
      result.append(character)
      used += bytes
    }
    return result
  }

  private static func extensionForMime(_ mime: String) -> String {
    switch mime {
    case "text/markdown", "text/x-markdown":
      return "md"
    case "text/plain":
      return "txt"
    case "text/html":
      return "html"
    case "text/css":
      return "css"
    case "application/json":
      return "json"
    case "application/pdf":
      return "pdf"
    case "application/zip":
      return "zip"
    case "image/png":
      return "png"
    case "image/jpeg":
      return "jpg"
    case "image/gif":
      return "gif"
    case "image/svg+xml":
      return "svg"
    default:
      let subtype = mime.split(separator: "/").last.map(String.init) ?? mime
      return subtype.isEmpty ? fallbackExtension : subtype
    }
  }
}
