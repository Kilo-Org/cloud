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

  private let lock = NSLock()
  private var registration: DispatcherRegistration?
  /// Runs already waiting for `register(dispatcher:runtime:)`, keyed so that
  /// registration and the deadline each take exactly the waiter they own.
  private var waiters: [UUID: CheckedContinuation<DispatcherRegistration, Error>] = [:]
  /// Payloads that arrived before the dispatcher registered. iOS never parks
  /// one — `perform` waits for registration instead — but the module's
  /// registration contract returns this buffer to the JS side, which is the
  /// same shape every entry point sees.
  private var parkedPayloads: [[String: String]] = []

  private init() {}

  /// Stores the JS dispatcher of `runtime` and hands it to every run already
  /// waiting. A late registration resumes its callers directly instead of them
  /// re-checking on a timer.
  ///
  /// Runs on the JS thread of `runtime` (the module's synchronous `@JS` method),
  /// because it adds the registration to `runtime.longLivedObjects` and can
  /// release a replaced dispatcher of the same runtime. A replaced registration
  /// of an earlier runtime is not released here: that runtime's teardown sweep
  /// owns it, and on reload it already ran, before this runtime started.
  @JavaScriptActor
  func register(dispatcher: consuming JavaScriptValue, runtime: JavaScriptRuntime) {
    let next = DispatcherRegistration(dispatcher: dispatcher, runtime: runtime)
    runtime.longLivedObjects.add(next)
    lock.lock()
    let previous = registration
    registration = next
    let waiting = waiters
    waiters = [:]
    lock.unlock()
    if let previous, previous.runtime === runtime {
      runtime.longLivedObjects.remove(previous)
      previous.allowRelease()
    }
    for waiter in waiting.values {
      waiter.resume(returning: next)
    }
  }

  /// Forgets `released` when its runtime's teardown sweep releases it.
  ///
  /// A registration of an earlier runtime does not clear a later one. Clearing
  /// makes the next run wait for the replacement registration, which
  /// `waitUntilRegistered` already bounds. The parked buffer goes with it — a
  /// payload delivered to a dead runtime is not replayed against the next one.
  /// This only drops the bridge's reference; it never destroys a JSI value.
  fileprivate func unregister(_ released: DispatcherRegistration) {
    lock.lock()
    defer { lock.unlock() }
    guard registration === released else {
      return
    }
    registration = nil
    parkedPayloads = []
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

  /// Waits, bounded, for the JS dispatcher.
  ///
  /// Returns the registration at once when there is one; otherwise parks a
  /// `CheckedContinuation` that `register(dispatcher:runtime:)` resumes, and
  /// starts the one deadline task that fails it with
  /// `KiloAppActionError.dispatcherUnavailable`. A waiter removed from the
  /// store is the only one resumed, so registration and the deadline cannot
  /// resume the same continuation twice.
  ///
  /// Waiting is the capability iOS has and Android does not: an App Intent's
  /// `perform` answers its caller, so the bridge has to hold the run until JS
  /// registers. Android's counterpart (`KiloAppActionsModule.kt`'s
  /// `AppActionDispatcher`) never waits at all — it buffers a payload that
  /// arrives before registration and hands it back at `register`, and its
  /// `KiloActionActivity` answers through `setResult`.
  private func waitUntilRegistered(
    timeout: TimeInterval = KiloAppActionBridge.registrationTimeout
  ) async throws -> DispatcherRegistration {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if let registration {
        lock.unlock()
        continuation.resume(returning: registration)
        return
      }
      let id = UUID()
      waiters[id] = continuation
      lock.unlock()
      startDeadline(for: id, timeout: timeout)
    }
  }

  /// Starts the one task that fails `id` when registration has not arrived
  /// inside `timeout`.
  private func startDeadline(for id: UUID, timeout: TimeInterval) {
    Task {
      try? await Task.sleep(for: .seconds(timeout))
      self.failWaiter(id, seconds: Int(timeout))
    }
  }

  /// Fails one parked waiter at its deadline. Taking it out of the store first
  /// is what makes this the only resume for that continuation.
  private func failWaiter(_ id: UUID, seconds: Int) {
    lock.lock()
    let waiter = waiters.removeValue(forKey: id)
    lock.unlock()
    waiter?.resume(throwing: KiloAppActionError.dispatcherUnavailable(seconds: seconds))
  }

  /// Runs one action through the JS pipeline.
  ///
  /// `payload` is the JSON object `src/lib/app-actions/app-action-contract.ts`
  /// parses: `action`, and the fields that action declares. The answer is the
  /// `AppActionResult` for that request — a successful `StartAgent` reports the
  /// session id it created, and a refused one throws with the pipeline's own
  /// message, so Shortcuts shows a real result instead of a silent success.
  func perform(payload: [String: String]) async throws -> String {
    let registration = try await waitUntilRegistered()
    do {
      // All JSI access happens on the JS thread; the answer crosses back as a
      // plain `String`.
      return try await registration.runtime.execute {
        let answer = try registration.call(payload: payload)
        let resolved = try await KiloAppActionBridge.resolved(answer)
        return try KiloAppActionBridge.result(from: resolved)
      }
    } catch let error as KiloAppActionError {
      throw error
    } catch {
      throw KiloAppActionError.refused(message: error.localizedDescription, retryable: true)
    }
  }

  /// The fields this side reads from the JS `AppActionResult`.
  private struct Answer: Decodable {
    let ok: Bool?
    let sessionId: String?
    let message: String?
    let retryable: Bool?
    let code: String?
  }

  /// The result code a declined confirmation reports.
  private static let cancelledCode = "start-cancelled"

  /// The dispatcher may answer with the result or with a promise of it; both
  /// are accepted, and a rejected promise propagates its JS error.
  @JavaScriptActor
  private static func resolved(_ answer: consuming JavaScriptValue) async throws -> JavaScriptValue {
    do {
      return try await answer.asPromise().await()
    } catch is JavaScriptValue.TypeError {
      // A synchronous answer: the dispatcher returned the result itself.
      return answer
    }
  }

  /// The caller-facing result: the session id a `StartAgent` run created. A
  /// declined confirmation reports its message as a normal value; any other
  /// refusal throws with the pipeline's message.
  @JavaScriptActor
  private static func result(from answer: borrowing JavaScriptValue) throws -> String {
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
    if decoded.code == cancelledCode, let message = nonBlank(decoded.message) {
      return message
    }
    throw KiloAppActionError.refused(
      message: nonBlank(decoded.message),
      retryable: decoded.retryable ?? false
    )
  }

  /// Reads the answer as the `AppActionResult` object, or as its JSON text —
  /// the two forms the contract accepts.
  @JavaScriptActor
  private static func decode(_ answer: borrowing JavaScriptValue) throws -> Answer {
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
    let code = object.getProperty("code")
    return Answer(
      ok: ok.isBool() ? ok.getBool() : nil,
      sessionId: sessionId.isString() ? sessionId.getString() : nil,
      message: message.isString() ? message.getString() : nil,
      retryable: retryable.isBool() ? retryable.getBool() : nil,
      code: code.isString() ? code.getString() : nil
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

/// The JS dispatcher one runtime registered, and that runtime.
///
/// The runtime's `longLivedObjects` owns this object. When the runtime tears
/// down (a reload, such as the RTL language switch), the sweep calls
/// `allowRelease()` on the JS thread while the runtime is still valid. That is
/// the same contract `JavaScriptPromise` uses for the JSI values it holds.
/// The dispatcher's JSI value is only destroyed there, or when the same
/// runtime registers again: both on the JS thread of its own runtime. The
/// bridge only borrows the object, so the bridge can drop it on any thread.
@JavaScriptActor
private final class DispatcherRegistration: LongLivedObject {
  nonisolated let runtime: JavaScriptRuntime
  private let dispatcher: JavaScriptValue.Ref

  init(dispatcher: consuming JavaScriptValue, runtime: JavaScriptRuntime) {
    self.dispatcher = dispatcher.ref()
    self.runtime = runtime
  }

  /// Calls the dispatcher with one payload. The dispatcher reference is not
  /// kept past this call, so a teardown while the answer is pending still
  /// releases the dispatcher on time.
  func call(payload: [String: String]) throws -> JavaScriptValue {
    guard let answer = try dispatcher.withUnwrappedValue({ (dispatcher: borrowing JavaScriptValue) in
      try dispatcher.getFunction().call(arguments: payload)
    }) else {
      throw KiloAppActionError.dispatcherUnavailable(
        seconds: Int(KiloAppActionBridge.registrationTimeout)
      )
    }
    return answer
  }

  func allowRelease() {
    dispatcher.release()
    KiloAppActionBridge.shared.unregister(self)
  }
}
