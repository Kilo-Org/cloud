import ExpoModulesCore
import Foundation

/// A run of a native entry point that could not report a result.
///
/// The App Intents turn these into what Shortcuts shows: `errorDescription` is
/// the caller-facing line, and the JS `message` is preferred over every
/// built-in one whenever the pipeline sent it.
enum KiloAppActionError: Error, LocalizedError {
  /// No JS dispatcher registered inside the bounded wait: the app is still
  /// starting, or its JS runtime never came up.
  case dispatcherUnavailable(seconds: Int)
  /// The dispatcher answered with something that is not the `AppActionResult`
  /// contract, so there is no honest result to report.
  case malformedResult
  /// The action refused to run. `message` is the JS-side reason; the caller
  /// supplies its own copy when the pipeline sent none.
  case refused(message: String?, retryable: Bool)
  /// The system declined to open the action's link into the app.
  case linkRefused

  var errorDescription: String? {
    switch self {
    case .dispatcherUnavailable(let seconds):
      return "Kilo did not finish starting within \(seconds) seconds, so the action did not run. "
        + "Open Kilo and try again."
    case .malformedResult:
      return "Kilo answered with a result this action could not read."
    case .refused(let message, _):
      return message
    case .linkRefused:
      return "The system did not hand the link to Kilo."
    }
  }
}

/// The one place a native entry point and the JS action pipeline meet.
///
/// A plain singleton rather than an Expo module instance: an App Intent runs
/// outside the module's lifecycle (iOS launches the app in the background to
/// answer one), and it has to reach the dispatcher the JS side registered once
/// for the whole runtime. The bridge owns no action logic — it hands the
/// payload over and reports the `AppActionResult` back, so the in-app control
/// and the OS entry points run the exact same code path.
final class KiloAppActionBridge: @unchecked Sendable {
  static let shared = KiloAppActionBridge()

  /// How long a run waits for `registerAppActionDispatcher` before it reports a
  /// failure. A background App Intent is killed by the system long before this,
  /// so the wait is a hard bound, never a hang.
  static let registrationTimeout: TimeInterval = 25

  /// The gap between two registration checks.
  private static let registrationPollInterval: Duration = .milliseconds(50)

  private let lock = NSLock()
  private var dispatcher: JavaScriptValue?
  private var runtime: JavaScriptRuntime?
  /// Payloads that arrived before the dispatcher registered. iOS never parks
  /// one — `perform` waits for registration instead — but the module's
  /// registration contract returns this buffer to the JS side, which is the
  /// same shape every entry point sees.
  private var parkedPayloads: [[String: String]] = []

  private init() {}

  /// Stores the JS dispatcher and the runtime it belongs to.
  func register(dispatcher: JavaScriptValue, runtime: JavaScriptRuntime) {
    lock.lock()
    self.dispatcher = dispatcher
    self.runtime = runtime
    lock.unlock()
  }

  /// Drops the registered dispatcher and runtime when the JS runtime goes away.
  ///
  /// The mirror of the Android module's `OnDestroy` clear: a singleton that kept
  /// a torn-down runtime would let a later App Intent execute on it. Clearing
  /// makes the next run wait for the replacement registration, which
  /// `waitUntilRegistered` already bounds. The parked buffer goes with it — a
  /// payload delivered to a dead runtime is not replayed against the next one.
  func unregister() {
    lock.lock()
    dispatcher = nil
    runtime = nil
    parkedPayloads = []
    lock.unlock()
  }

  /// Hands back the parked payloads and clears the buffer.
  func drainParkedPayloads() -> [[String: String]] {
    lock.lock()
    defer { lock.unlock() }
    let drained = parkedPayloads
    parkedPayloads = []
    return drained
  }

  /// Parks a payload whose dispatcher has not registered yet.
  func park(payload: [String: String]) {
    lock.lock()
    parkedPayloads.append(payload)
    lock.unlock()
  }

  /// Waits, bounded, for the JS dispatcher. Throws
  /// `KiloAppActionError.dispatcherUnavailable` at the deadline, so a caller
  /// always gets a result.
  func waitUntilRegistered(
    timeout: TimeInterval = KiloAppActionBridge.registrationTimeout
  ) async throws -> (dispatcher: JavaScriptValue, runtime: JavaScriptRuntime) {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
      if let registered = registered() {
        return registered
      }
      if Date() >= deadline {
        throw KiloAppActionError.dispatcherUnavailable(seconds: Int(timeout))
      }
      try await Task.sleep(for: KiloAppActionBridge.registrationPollInterval)
    }
  }

  /// Runs one action through the JS pipeline.
  ///
  /// `payload` is the JSON object `src/lib/app-actions/app-action-contract.ts`
  /// parses: `action`, and the fields that action declares. The answer is the
  /// `AppActionResult` for that request — a successful `StartAgent` reports the
  /// session id it created, and a refused one throws with the pipeline's own
  /// message, so Shortcuts shows a real result instead of a silent success.
  func perform(payload: [String: String]) async throws -> String {
    let registered = try await waitUntilRegistered()
    do {
      // All JSI access happens on the JS thread; the answer crosses back as a
      // plain `String`.
      return try await registered.runtime.execute {
        // `JavaScriptValue` only holds the reference; the callable form is its
        // function view. Same idiom as ExpoModulesJSI's own promise resolvers.
        let answer = try registered.dispatcher.getFunction().call(arguments: payload)
        let resolved = try await KiloAppActionBridge.resolved(answer)
        return try KiloAppActionBridge.result(from: resolved)
      }
    } catch let error as KiloAppActionError {
      throw error
    } catch {
      throw KiloAppActionError.refused(message: error.localizedDescription, retryable: true)
    }
  }

  /// The registered dispatcher and runtime, or nil while JS has not registered.
  private func registered() -> (dispatcher: JavaScriptValue, runtime: JavaScriptRuntime)? {
    lock.lock()
    defer { lock.unlock() }
    guard let dispatcher, let runtime else {
      return nil
    }
    return (dispatcher, runtime)
  }

  /// The fields this side reads from the JS `AppActionResult`.
  private struct Answer: Decodable {
    let ok: Bool?
    let sessionId: String?
    let message: String?
    let retryable: Bool?
  }

  /// The dispatcher may answer with the result or with a promise of it; both
  /// are accepted, and a rejected promise propagates its JS error.
  @JavaScriptActor
  private static func resolved(_ answer: JavaScriptValue) async throws -> JavaScriptValue {
    do {
      return try await answer.asPromise().await()
    } catch is JavaScriptValue.TypeError {
      // A synchronous answer: the dispatcher returned the result itself.
      return answer
    }
  }

  /// The caller-facing result: the session id a `StartAgent` run created.
  /// A refusal throws with the pipeline's message.
  private static func result(from answer: JavaScriptValue) throws -> String {
    let decoded = try decode(answer)
    guard let ok = decoded.ok else {
      throw KiloAppActionError.malformedResult
    }
    if ok {
      if let sessionId = nonBlank(decoded.sessionId) {
        return sessionId
      }
      guard let message = nonBlank(decoded.message) else {
        throw KiloAppActionError.malformedResult
      }
      return message
    }
    throw KiloAppActionError.refused(
      message: nonBlank(decoded.message),
      retryable: decoded.retryable ?? false
    )
  }

  /// Reads the answer as the `AppActionResult` object, or as its JSON text —
  /// the two forms the contract accepts.
  private static func decode(_ answer: JavaScriptValue) throws -> Answer {
    if answer.isString() {
      guard let data = answer.getString().data(using: .utf8) else {
        throw KiloAppActionError.malformedResult
      }
      do {
        return try JSONDecoder().decode(Answer.self, from: data)
      } catch {
        throw KiloAppActionError.malformedResult
      }
    }
    guard answer.isObject() else {
      throw KiloAppActionError.malformedResult
    }
    let object = answer.getObject()
    let ok = object.getProperty("ok")
    let sessionId = object.getProperty("sessionId")
    let message = object.getProperty("message")
    let retryable = object.getProperty("retryable")
    return Answer(
      ok: ok.isBool() ? ok.getBool() : nil,
      sessionId: sessionId.isString() ? sessionId.getString() : nil,
      message: message.isString() ? message.getString() : nil,
      retryable: retryable.isBool() ? retryable.getBool() : nil
    )
  }

  /// A trimmed non-empty string, or nil.
  private static func nonBlank(_ value: String?) -> String? {
    guard let value else {
      return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
