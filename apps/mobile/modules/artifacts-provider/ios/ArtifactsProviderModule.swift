import ExpoModulesCore
import FileProvider

/**
 JS bridge that owns the iOS File Provider domain serving the artifact mirror.

 A `com.apple.fileprovider-nonui` extension has no domain until its containing
 app adds one, so this lives in the app process: `ArtifactMirrorSyncMount`
 calls `registerArtifactsProviderDomain()` on a signed-in mount and the mirror
 engine calls `notifyArtifactsChanged()` after each sync. The extension itself
 (`apps/mobile/targets/ArtifactsFileProvider/`) only reads the app-group mirror.
 */
public final class ArtifactsProviderModule: Module {
  /**
   The one domain this app owns. iOS keys the extension behind it, so the
   identifier must never change once shipped.
   */
  private static let domainIdentifier = "com.kilocode.kiloapp.artifacts"

  /** The location's name in the Files app. */
  private static let domainDisplayName = "Kilo"

  public func definition() -> ModuleDefinition {
    Name("ArtifactsProvider")

    // Named for the JS bridge (`src/lib/artifacts/artifact-provider-native.ts`).
    Function("registerArtifactsProviderDomain") {
      self.registerProviderDomain()
    }

    // Android's provider is served in-process and carries no domain, so only
    // the iOS entry point does anything here.
    Function("notifyArtifactsChanged") {
      self.notifyArtifactsChanged()
    }
  }

  // MARK: - File Provider domain

  /**
   Registers the domain when it is not registered yet.

   Idempotent: the registered domains are read first, so a cold start, a
   sign-in and a foreground refresh all converge on the one domain instead of
   racing to add it. A domain outlives the session that registered it: sign-out
   clears the mirror instead, so the extension serves an empty location.

   The enumeration is `getDomainsWithCompletionHandler(_:)`, the name the
   FileProvider SDK declares for `+getDomainsWithCompletionHandler:`
   (`NSFileProviderManager.h`): there is no `getDomains` member, and the
   header's `NS_ASSUME_NONNULL_BEGIN` makes the domain list non-optional, so it
   is handed to `isRegistered` as read.
   */
  private func registerProviderDomain() {
    let domain = Self.fileProviderDomain
    NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
      if let error {
        NSLog(
          "[ArtifactsProvider] Could not read the File Provider domains: %@",
          error.localizedDescription
        )
        return
      }
      guard !Self.isRegistered(domain, among: domains) else {
        return
      }
      NSFileProviderManager.add(domain) { error in
        guard let error else {
          return
        }
        // Losing a race with a concurrent registration is harmless: the other
        // call registered this same domain, and the Files app reads this mirror.
        NSLog(
          "[ArtifactsProvider] Could not register the File Provider domain: %@",
          error.localizedDescription
        )
      }
    }
  }

  /**
   Tells the system the root container changed, so the Files app re-queries the
   mirror instead of showing a stale location.
   */
  private func notifyArtifactsChanged() {
    let domain = Self.fileProviderDomain
    guard let manager = NSFileProviderManager(for: domain) else {
      return
    }
    manager.signalEnumerator(for: .rootContainer) { error in
      guard let error else {
        return
      }
      NSLog(
        "[ArtifactsProvider] Could not signal the File Provider root: %@",
        error.localizedDescription
      )
    }
  }

  private static var fileProviderDomain: NSFileProviderDomain {
    NSFileProviderDomain(
      identifier: NSFileProviderDomainIdentifier(rawValue: domainIdentifier),
      displayName: domainDisplayName
    )
  }

  /** Whether the domain this app owns is in a list of registered domains. */
  private static func isRegistered(
    _ domain: NSFileProviderDomain,
    among domains: [NSFileProviderDomain]
  ) -> Bool {
    domains.contains { $0.identifier.rawValue == domain.identifier.rawValue }
  }
}
