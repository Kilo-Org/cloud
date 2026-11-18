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
    // Async so the mount learns whether the Files-app location exists: the
    // promise rejects when the domain could not be read or added.
    AsyncFunction("registerArtifactsProviderDomain") {
      try await self.registerProviderDomain()
    }

    // Android's provider is served in-process and carries no domain, so only
    // the iOS entry point does anything here.
    Function("notifyArtifactsChanged") {
      self.notifyArtifactsChanged()
    }
  }

  // MARK: - File Provider domain

  /**
   Registers the domain when it is not registered yet, and reports failure to
   the mount: the `AsyncFunction` entry point rejects, which `Sentry` records
   instead of a silent no-op.

   Idempotent: the registered domains are read first, so a cold start, a
   sign-in and a foreground refresh all converge on the one domain instead of
   racing to add it. A domain outlives the session that registered it: sign-out
   clears the mirror instead, so the extension serves an empty location.

   The completion handlers bridge to the `async` caller through
   `withCheckedThrowingContinuation`, and each resumes its continuation once:
   the error branches `return` right after resuming with the error, the
   early-exit branches resume with `()` before returning, and the inner add
   handler is resumed only on the path that reached it.

   The enumeration is `getDomainsWithCompletionHandler(_:)`, the name the
   FileProvider SDK declares for `+getDomainsWithCompletionHandler:`
   (`NSFileProviderManager.h`): there is no `getDomains` member, and the
   header's `NS_ASSUME_NONNULL_BEGIN` makes the domain list non-optional, so it
   is handed to `isRegistered` as read.
   */
  private func registerProviderDomain() async throws {
    let domain = Self.fileProviderDomain
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
        if let error {
          NSLog(
            "[ArtifactsProvider] Could not read the File Provider domains: %@",
            error.localizedDescription
          )
          continuation.resume(throwing: error)
          return
        }
        guard !Self.isRegistered(domain, among: domains) else {
          continuation.resume(returning: ())
          return
        }
        NSFileProviderManager.add(domain) { error in
          if let error {
            // Losing a race with a concurrent registration is harmless: the
            // other call registered this same domain, and the Files app reads
            // this mirror.
            NSLog(
              "[ArtifactsProvider] Could not register the File Provider domain: %@",
              error.localizedDescription
            )
            continuation.resume(throwing: error)
            return
          }
          continuation.resume(returning: ())
        }
      }
    }
  }

  /**
   Tells the system the root container changed, so the Files app re-queries the
   mirror instead of showing a stale location.

   When the File Provider manager for the domain is missing — the domain not
   registered yet, or not yet visible to this process — the domain is
   registered again as recovery, and the root is signalled once that lands so a
   domain that appeared after the sync still reaches the Files app. The work is
   launched without blocking the mirror's reply: recovering here once avoids a
   recursive `notifyArtifactsChanged()` call, and no retry timer is set — a
   signed-in mount re-runs registration anyway.
   */
  private func notifyArtifactsChanged() {
    let domain = Self.fileProviderDomain
    guard let manager = NSFileProviderManager(for: domain) else {
      NSLog("[ArtifactsProvider] File Provider manager unavailable; registering the domain again")
      Task { [weak self] in
        guard let module = self else {
          return
        }
        do {
          try await module.registerProviderDomain()
        } catch {
          NSLog(
            "[ArtifactsProvider] Could not register the File Provider domain: %@",
            error.localizedDescription
          )
          return
        }
        module.signalArtifactsChanged()
      }
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

  /**
   Tells the system the registered domain's root container changed, so the
   Files app re-queries it. The recovery path signals from here once the new
   registration lands; the manager-present path above owns its own signal.
   */
  private func signalArtifactsChanged() {
    let manager = NSFileProviderManager(for: Self.fileProviderDomain)
    manager?.signalEnumerator(for: .rootContainer) { error in
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
    let domain = NSFileProviderDomain(
      identifier: NSFileProviderDomainIdentifier(rawValue: domainIdentifier),
      displayName: domainDisplayName
    )
    // Dev-only: automatically enables the domain so the Files app can open the
    // location without the per-user enable step. The signal is the
    // Info.plist key the app config bakes for non-production profiles (the
    // same profiles that carry the testing-mode entitlement) — `#if DEBUG`
    // would not fire, because EAS builds non-production profiles with the
    // Release configuration. iOS rejects any build that sets a testing mode
    // without the entitlement, and production builds carry neither.
    if Bundle.main.object(forInfoDictionaryKey: "KiloArtifactsFileProviderTesting") != nil {
      domain.testingModes = [.alwaysEnabled]
    }
    return domain
  }

  /** Whether the domain this app owns is in a list of registered domains. */
  private static func isRegistered(
    _ domain: NSFileProviderDomain,
    among domains: [NSFileProviderDomain]
  ) -> Bool {
    domains.contains { $0.identifier.rawValue == domain.identifier.rawValue }
  }
}
