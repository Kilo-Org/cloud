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
      completionHandler(ArtifactItem(file: file, sessionId: sessionId), nil)
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
    do {
      let staged = try Self.stage(source: source, filename: file.name)
      progress.completedUnitCount = 1
      completionHandler(staged, ArtifactItem(file: file, sessionId: sessionId), nil)
    } catch {
      completionHandler(nil, nil, error)
    }
    return progress
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
  let capabilities: NSFileProviderItemCapabilities

  /** The location's own root, which the Files app titles with the domain name. */
  static let root = ArtifactItem(
    itemIdentifier: .rootContainer,
    parentItemIdentifier: .rootContainer,
    filename: "Kilo",
    contentType: .folder,
    documentSize: nil,
    isDirectory: true
  )

  init(
    itemIdentifier: NSFileProviderItemIdentifier,
    parentItemIdentifier: NSFileProviderItemIdentifier,
    filename: String,
    contentType: UTType,
    documentSize: NSNumber?,
    isDirectory: Bool
  ) {
    self.itemIdentifier = itemIdentifier
    self.parentItemIdentifier = parentItemIdentifier
    self.filename = filename
    self.contentType = contentType
    self.documentSize = documentSize
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
      isDirectory: true
    )
  }

  /** A mirrored file, typed from its manifest MIME type. */
  convenience init(file: ArtifactManifest.File, sessionId: String) {
    self.init(
      itemIdentifier: ArtifactItemIdentifier.encodeFile(file.id, inSession: sessionId),
      parentItemIdentifier: ArtifactItemIdentifier.encodeSession(sessionId),
      filename: file.name,
      contentType: UTType(mimeType: file.mime) ?? .data,
      documentSize: NSNumber(value: file.size),
      isDirectory: false
    )
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
 */
struct ArtifactMirror {
  /** App group shared with the app; must match the entitlement. */
  static let appGroupIdentifier = "group.com.kilocode.kiloapp"
  static let directoryName = "artifacts"
  static let sessionsDirectoryName = "sessions"
  static let manifestFileName = "manifest.json"
  static let supportedManifestVersion = 1

  /**
   The manifest, or nil when there is none (signed out, or a first run that has
   not mirrored yet). An unreadable or unknown-version index reads as absent:
   the mirror is derived data, so a reader shows nothing rather than failing.
   */
  func manifest() -> ArtifactManifest? {
    guard let url = Self.manifestURL(), let data = try? Data(contentsOf: url),
      let manifest = try? JSONDecoder().decode(ArtifactManifest.self, from: data),
      manifest.version == Self.supportedManifestVersion
    else {
      return nil
    }
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
      return (session(id: sessionId)?.files ?? []).map {
        ArtifactItem(file: $0, sessionId: sessionId)
      }
    case .file, .unknown:
      return []
    }
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
