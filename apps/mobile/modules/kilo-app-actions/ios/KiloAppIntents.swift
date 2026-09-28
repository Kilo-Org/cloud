import AppIntents
import UIKit

// The English copy the four App Intents carry.
//
// An App Intent's `title`, its parameter names and a shortcut's title are
// `LocalizedStringResource`s that iOS resolves against `Localizable.strings`
// in the app bundle, so the literal is both the key and the fallback. It has
// to be written at the use site: `appintentsmetadataprocessor`, which runs on
// this target at build time, reads these sources and halts the target with
// "'LocalizedStringResource' must be initialized with a call to its
// initializer or a string literal" for anything else, so a shared `static let`
// copy table fails the build. `plugins/app-intent-copy.json` holds one
// translation per language under exactly these English strings, and the
// contract test compares each literal with that file.

/// The `kiloapp:///actions/<slug>` targets the app's own pipeline resolves.
///
/// Every slug here is one `APP_ACTION_SLUGS` in
/// `src/lib/app-actions/app-action-contract.ts` declares, and the contract test
/// parses each literal with that module's `parseAppActionUrl`, so the Swift and
/// JS grammars cannot drift.
enum KiloAppActionTarget {
  static let openNeedsInput = "kiloapp:///actions/open-needs-input"
  static let openSession = "kiloapp:///actions/open-session"
  static let openPullRequest = "kiloapp:///actions/open-pull-request"

  /// The target with its query, or nil when it cannot be built.
  static func url(_ target: String, query: [String: String] = [:]) -> URL? {
    guard var components = URLComponents(string: target) else {
      return nil
    }
    if !query.isEmpty {
      components.queryItems = query.sorted { $0.key < $1.key }.map {
        URLQueryItem(name: $0.key, value: $0.value)
      }
    }
    return components.url
  }

  /// Opens the target for the app's own routing to pick up. `openAppWhenRun`
  /// has already brought the app forward; this hands it the action.
  @MainActor
  static func open(_ target: String, query: [String: String] = [:]) async throws {
    guard let url = url(target, query: query) else {
      throw KiloAppActionError.malformedResult
    }
    let opened: Bool = await withCheckedContinuation { continuation in
      UIApplication.shared.open(url, options: [:]) { opened in
        continuation.resume(returning: opened)
      }
    }
    if !opened {
      throw KiloAppActionError.linkRefused
    }
  }
}

/// Starts a new agent. The app may be closed: the bridge hands the payload to
/// the JS pipeline, which owns the whole start path, and reports its answer.
struct StartAgentIntent: AppIntent {
  static var title: LocalizedStringResource = "Start agent"
  static var openAppWhenRun: Bool = false

  @Parameter(title: "Prompt")
  var prompt: String

  @Parameter(title: "Repository")
  var repository: String?

  @Parameter(title: "Session")
  var session: String?

  func perform() async throws -> some IntentResult & ReturnsValue<String> {
    var payload = ["action": "StartAgent", "prompt": prompt]
    if let repository = Self.named(repository) {
      payload["repository"] = repository
    }
    if let session = Self.named(session) {
      payload["sessionId"] = session
    }
    do {
      return .result(value: try await KiloAppActionBridge.shared.perform(payload: payload))
    } catch let error as KiloAppActionError {
      throw Self.reported(error)
    }
  }

  /// A named parameter, or nil when the run left it empty.
  private static func named(_ value: String?) -> String? {
    guard let value else {
      return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// Shortcuts shows the thrown error's description, so a refusal the pipeline
  /// sent without a message reports this action's own fallback copy.
  private static func reported(_ error: KiloAppActionError) -> KiloAppActionError {
    if case .refused(let message, let retryable) = error, (message ?? "").isEmpty {
      return .refused(
        message: String(localized: "Couldn't start the agent. Open Kilo and try again."),
        retryable: retryable
      )
    }
    return error
  }
}

/// Opens the agent that is waiting for an answer, or the list when none or
/// several are waiting. The app resolves both cases from live data.
struct OpenNeedsInputIntent: AppIntent {
  static var title: LocalizedStringResource = "Open agent needing input"
  static var openAppWhenRun: Bool = true

  func perform() async throws -> some IntentResult {
    try await KiloAppActionTarget.open(KiloAppActionTarget.openNeedsInput)
    return .result()
  }
}

/// Opens one session by its id.
struct OpenSessionIntent: AppIntent {
  static var title: LocalizedStringResource = "Open session"
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Session")
  var session: String

  func perform() async throws -> some IntentResult {
    try await KiloAppActionTarget.open(
      KiloAppActionTarget.openSession,
      query: ["sessionId": session]
    )
    return .result()
  }
}

/// Opens one pull request by its link or id.
struct OpenPullRequestIntent: AppIntent {
  static var title: LocalizedStringResource = "Open pull request"
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Pull request")
  var pullRequest: String

  func perform() async throws -> some IntentResult {
    try await KiloAppActionTarget.open(
      KiloAppActionTarget.openPullRequest,
      query: ["pullRequest": pullRequest]
    )
    return .result()
  }
}

/// Lists the four actions in the Shortcuts app, which is the surface that makes
/// them addressable from outside the app. Every phrase carries the app name,
/// which the provider requires; no other OS surface is declared here.
struct KiloAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartAgentIntent(),
      phrases: ["Start an agent with \(.applicationName)"],
      shortTitle: "Start agent",
      systemImageName: "plus.circle"
    )
    AppShortcut(
      intent: OpenNeedsInputIntent(),
      phrases: ["Show the agent that needs input in \(.applicationName)"],
      shortTitle: "Open agent needing input",
      systemImageName: "hand.raised"
    )
    AppShortcut(
      intent: OpenSessionIntent(),
      phrases: ["Open a session in \(.applicationName)"],
      shortTitle: "Open session",
      systemImageName: "bubble.left"
    )
    AppShortcut(
      intent: OpenPullRequestIntent(),
      phrases: ["Open a pull request in \(.applicationName)"],
      shortTitle: "Open pull request",
      systemImageName: "arrow.triangle.pull"
    )
  }
}
