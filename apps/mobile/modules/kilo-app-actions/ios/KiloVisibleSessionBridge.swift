import ExpoModulesCore

/// The app delegate installs this before React starts; a missing publisher fails the JS call.
@MainActor
public enum KiloVisibleSessionBridge {
  public typealias Publisher = @MainActor (String?) -> Void

  private static var installedPublisher: Publisher?

  public static func install(publisher: @escaping Publisher) {
    installedPublisher = publisher
  }

  static func publish(_ sessionId: String?) throws {
    let publisher = installedPublisher
    guard let publisher else {
      throw VisibleSessionPublisherNotInstalledException()
    }
    publisher(sessionId)
  }
}

private final class VisibleSessionPublisherNotInstalledException: Exception, @unchecked Sendable {
  override var reason: String {
    "KiloAppActions has no visible-session publisher installed. The app target installs one at launch."
  }
}
