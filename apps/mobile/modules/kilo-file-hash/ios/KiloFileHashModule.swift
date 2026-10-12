import CryptoKit
import ExpoModulesCore

private let chunkBytes = 1024 * 1024

public final class KiloFileHashModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KiloFileHash")

    // Async functions run on the module's own queue, off the JS and main threads.
    AsyncFunction("sha256File") { (uri: URL) -> String in
      let handle = try FileHandle(forReadingFrom: uri)
      defer { try? handle.close() }
      var hash = SHA256()
      var reading = true
      while reading {
        try autoreleasepool {
          let chunk = try handle.read(upToCount: chunkBytes) ?? Data()
          if chunk.isEmpty {
            reading = false
          } else {
            hash.update(data: chunk)
          }
        }
      }
      return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
  }
}
