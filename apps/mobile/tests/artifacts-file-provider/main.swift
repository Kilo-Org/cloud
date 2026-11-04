import Darwin
import FileProvider
import Foundation

// Compiled with the shipped extension and Apple's real FileProvider framework
// by mobile-native-build. All filesystem data belongs to this temporary mirror.
private var assertions = 0

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
  assertions += 1
}

private final class AnchorResult: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: NSFileProviderSyncAnchor?

  func set(_ value: NSFileProviderSyncAnchor?) {
    lock.lock()
    stored = value
    lock.unlock()
  }

  func get() -> NSFileProviderSyncAnchor? {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }
}

private final class ItemsObserver: NSObject, NSFileProviderEnumerationObserver {
  var items: [NSFileProviderItem] = []
  var completions = 0
  var error: Error?

  func didEnumerate(_ updatedItems: [NSFileProviderItem]) {
    items.append(contentsOf: updatedItems)
  }

  func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
    check(nextPage == nil, "The complete mirror must finish its single page")
    completions += 1
  }

  func finishEnumeratingWithError(_ error: Error) {
    self.error = error
  }
}

private final class ChangesObserver: NSObject, NSFileProviderChangeObserver {
  var updates: [NSFileProviderItem] = []
  var deletions: [NSFileProviderItemIdentifier] = []
  var completions = 0
  var anchor: NSFileProviderSyncAnchor?
  var moreComing: Bool?
  var error: Error?

  func didUpdate(_ updatedItems: [NSFileProviderItem]) {
    updates.append(contentsOf: updatedItems)
  }

  func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {
    deletions.append(contentsOf: deletedItemIdentifiers)
  }

  func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) {
    self.anchor = anchor
    self.moreComing = moreComing
    completions += 1
  }

  func finishEnumeratingWithError(_ error: Error) {
    self.error = error
  }
}

private func currentAnchor(_ enumerator: ArtifactsEnumerator) -> NSFileProviderSyncAnchor {
  let result = AnchorResult()
  enumerator.currentSyncAnchor { result.set($0) }
  guard let anchor = result.get() else { fatalError("The framework requires a non-nil sync anchor") }
  check(anchor.rawValue.count <= 500, "The sync anchor must fit the framework's byte limit")
  return anchor
}

private func listedItems(_ enumerator: ArtifactsEnumerator) -> [NSFileProviderItem] {
  let observer = ItemsObserver()
  let page = NSFileProviderPage(rawValue: NSFileProviderPage.initialPageSortedByName as Data)
  enumerator.enumerateItems(for: observer, startingAt: page)
  check(observer.error == nil, "An existing or empty mirror must enumerate successfully")
  check(observer.completions == 1, "Item enumeration must complete once")
  return observer.items
}

private func changed(
  _ enumerator: ArtifactsEnumerator,
  from anchor: NSFileProviderSyncAnchor
) -> ChangesObserver {
  let observer = ChangesObserver()
  enumerator.enumerateChanges(for: observer, from: anchor)
  return observer
}

private func checkUnchanged(
  _ enumerator: ArtifactsEnumerator,
  anchor: NSFileProviderSyncAnchor
) {
  let observer = changed(enumerator, from: anchor)
  check(observer.error == nil, "An unchanged generation must not expire its anchor")
  check(observer.completions == 1, "Unchanged observation must complete once")
  check(observer.anchor == anchor, "Unchanged observation must retain its anchor")
  check(observer.moreComing == false, "Unchanged observation must settle instead of looping")
  check(observer.updates.isEmpty && observer.deletions.isEmpty, "Unchanged observation has no changes")
}

private func checkExpired(_ observer: ChangesObserver) {
  let error = observer.error as NSError?
  let expected = NSFileProviderError(.syncAnchorExpired) as NSError
  check(error?.domain == expected.domain, "A replaced generation must expire its anchor")
  check(error?.code == expected.code, "The full enumeration must replace stale rows")
  check(observer.completions == 0, "An expired observation must not also finish successfully")
}

private func writeIndex(_ root: URL, firstTitle: String, includeSecond: Bool, includeDuplicate: Bool) throws {
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let duplicate = includeDuplicate ? ",{\"id\":\"file_b\",\"name\":\"report.csv\",\"mime\":\"text/csv\",\"size\":8}" : ""
  let second = includeSecond ? ",{\"id\":\"session_b\",\"title\":\"Session B\",\"files\":[]}" : ""
  let manifest = """
  {"version":1,"updatedAt":"fixed-fixture-time","sessions":[{"id":"session_a","title":"\(firstTitle)","files":[{"id":"file_a","name":"report.csv","mime":"text/csv","size":8}\(duplicate),{"id":"file_nested","name":"reports/2026/summary.md","mime":"text/markdown","size":10}]}\(second)]}
  """
  try Data(manifest.utf8).write(to: root.appendingPathComponent("manifest.json"), options: .atomic)
}

private func run() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("artifact-enumeration-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let mirror = ArtifactMirror(root: root)
  let enumerator = ArtifactsEnumerator(container: .root, mirror: mirror)
  check(enumerator.responds(to: NSSelectorFromString("currentSyncAnchorWithCompletionHandler:")), "The real framework selector must be implemented")

  let empty = currentAnchor(enumerator)
  check(listedItems(enumerator).isEmpty, "A missing mirror must expose an empty location")
  checkUnchanged(enumerator, anchor: empty)

  try writeIndex(root, firstTitle: "Session A", includeSecond: true, includeDuplicate: true)
  checkExpired(changed(enumerator, from: empty))
  let first = currentAnchor(enumerator)
  check(first != empty, "A populated mirror must have its own generation")
  check(listedItems(enumerator).map(\.filename) == ["Session A", "Session B"], "The root must list both sessions in manifest order")
  check(currentAnchor(enumerator) == first, "Reading an unchanged file must retain a stable anchor")
  checkUnchanged(enumerator, anchor: first)
  checkUnchanged(enumerator, anchor: first)

  let session = ArtifactsEnumerator(container: .session("session_a"), mirror: mirror)
  let sessionAnchor = currentAnchor(session)
  check(listedItems(session).map(\.filename) == ["report.csv", "report (2).csv", "summary.md"], "The real provider must resolve duplicates and nested display names")
  checkUnchanged(session, anchor: sessionAnchor)

  // Replacing an index between the anchor and first page must not combine generations.
  let beforeReplacement = currentAnchor(enumerator)
  let manifestURL = root.appendingPathComponent("manifest.json")
  var originalMetadata = stat()
  check(stat(manifestURL.path, &originalMetadata) == 0, "The published manifest must have a filesystem generation")
  try writeIndex(root, firstTitle: "Session Z", includeSecond: true, includeDuplicate: true)
  let times = [originalMetadata.st_atimespec, originalMetadata.st_mtimespec]
  check(utimensat(AT_FDCWD, manifestURL.path, times, 0) == 0, "The fixture must preserve the exact nanosecond modification stamp")
  var replacedMetadata = stat()
  check(stat(manifestURL.path, &replacedMetadata) == 0, "The replacement manifest must be published")
  check(replacedMetadata.st_ino != originalMetadata.st_ino, "Atomic replacement must have a distinct file identity")
  check(replacedMetadata.st_size == originalMetadata.st_size, "The replacement fixture must have the same size")
  check(replacedMetadata.st_mtimespec.tv_sec == originalMetadata.st_mtimespec.tv_sec
    && replacedMetadata.st_mtimespec.tv_nsec == originalMetadata.st_mtimespec.tv_nsec,
    "The replacement fixture must have the same modification stamp")
  check(listedItems(enumerator).map(\.filename) == ["Session A", "Session B"], "The page must use the snapshot whose anchor was returned")
  checkExpired(changed(enumerator, from: beforeReplacement))
  check(listedItems(enumerator).map(\.filename) == ["Session Z", "Session B"], "An expired generation must release its prepared page")
  let replacement = currentAnchor(enumerator)
  check(replacement != beforeReplacement, "Atomic replacement must advance the generation even with the same size and mtime")
  check(listedItems(enumerator).map(\.filename) == ["Session Z", "Session B"], "A full refresh must expose the replacement snapshot")
  checkUnchanged(enumerator, anchor: replacement)

  try writeIndex(root, firstTitle: "Session Z", includeSecond: false, includeDuplicate: false)
  checkExpired(changed(enumerator, from: replacement))
  _ = currentAnchor(enumerator)
  check(listedItems(enumerator).map(\.filename) == ["Session Z"], "A removed session must not survive full enumeration")
  checkExpired(changed(session, from: sessionAnchor))
  _ = currentAnchor(session)
  check(listedItems(session).map(\.filename) == ["report.csv", "summary.md"], "A removed file must not survive full enumeration")

  let populated = currentAnchor(enumerator)
  try FileManager.default.removeItem(at: root)
  checkExpired(changed(enumerator, from: populated))
  let released = currentAnchor(enumerator)
  check(released == empty, "A released mirror must return to the explicit empty generation")
  check(listedItems(enumerator).isEmpty, "Release must clear stale root rows")
  checkUnchanged(enumerator, anchor: released)

  try writeIndex(root, firstTitle: "Session A", includeSecond: true, includeDuplicate: true)
  checkExpired(changed(enumerator, from: released))
  let restored = currentAnchor(enumerator)
  check(restored != released, "Reseeding must leave the empty generation")
  check(listedItems(enumerator).count == 2, "Reseeding must restore both sessions")
  checkUnchanged(enumerator, anchor: restored)

  try Data("not-json".utf8).write(to: manifestURL, options: .atomic)
  checkExpired(changed(enumerator, from: restored))
  let invalid = currentAnchor(enumerator)
  check(invalid == empty, "An unreadable derived index must expose the existing empty state")
  check(listedItems(enumerator).isEmpty, "An unreadable index must not retain a cached populated snapshot")
  checkUnchanged(enumerator, anchor: invalid)
  print("ArtifactsFileProvider behavior: \(assertions) assertions passed")
}

try run()
