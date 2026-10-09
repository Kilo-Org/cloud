import ExpoModulesCore
import Foundation
import FoundationModels
import os

// Records are decoded once by Expo and never mutated after crossing into the
// engine actor. No transcript, session, or generated text is stored: a request
// lives only until its answer ends. A request that calls tools stays open while
// JavaScript runs them, and `resume` hands their results back to it.
struct AppleToolCall: Record, @unchecked Sendable {
  @Field var id: String = ""
  @Field var name: String = ""
  @Field var arguments: String = ""
}

// `role` is user, assistant, toolCalls (with `calls`), or toolOutput (with
// `callId`, `name`, and the output in `text`).
struct AppleModelMessage: Record, @unchecked Sendable {
  @Field var role: String = ""
  @Field var text: String = ""
  @Field var calls: [AppleToolCall] = []
  @Field var callId: String = ""
  @Field var name: String = ""
}

// `parameters` is the JSON of the schema tree JavaScript reduced to what
// DynamicGenerationSchema can express (native-tool-schema.ts).
struct AppleModelTool: Record, @unchecked Sendable {
  @Field var name: String = ""
  @Field var description: String = ""
  @Field var parameters: String = ""
}

struct AppleToolResult: Record, @unchecked Sendable {
  @Field var callId: String = ""
  @Field var body: String = ""
}

struct AppleModelRequest: Record, @unchecked Sendable {
  @Field var id: String = ""
  @Field var system: String = ""
  @Field var messages: [AppleModelMessage] = []
  @Field var maxTokens: Int = 0
  @Field var tools: [AppleModelTool] = []
}

public final class KiloAppleModelModule: Module {
  private let engine = AppleModelEngine()

  public func definition() -> ModuleDefinition {
    Name("KiloAppleModel")
    Events("onModelEvent")

    AsyncFunction("availability") { () async -> [String: Any] in
      await self.engine.availability()
    }

    AsyncFunction("countTokens") { (request: AppleModelRequest) async throws -> Int in
      try await self.engine.countTokens(request)
    }

    AsyncFunction("generate") { (request: AppleModelRequest) async throws in
      try await self.engine.generate(request) { [weak self] event in
        self?.sendEvent("onModelEvent", event)
      }
    }

    AsyncFunction("resume") { (id: String, results: [AppleToolResult]) async throws in
      try await self.engine.resume(id, results: results)
    }

    AsyncFunction("cancel") { (id: String) async in
      await self.engine.cancel(id)
    }

    AsyncFunction("release") { () async in
      await self.engine.release()
    }

    OnDestroy { [engine] in
      Task { await engine.release() }
    }
  }
}

// A coded Expo exception, so a rejected promise carries the same stable reason
// as its error event (`error.code` in JavaScript), like the Android module.
private final class AppleModelFailure: Exception, @unchecked Sendable {
  private let failure: String

  init(reason: String) {
    failure = reason
    super.init(name: "AppleModelFailure", description: reason, code: reason)
  }

  override var reason: String { failure }
}

private struct AppleModelCompletion: Sendable {
  var stop = "unknown"
  var inputTokens: Int?
  var outputTokens: Int?
  var usageSource = "unavailable"

  func event(id: String) -> [String: Any] {
    var event: [String: Any] = [
      "id": id, "kind": "done", "stop": stop, "usageSource": usageSource,
    ]
    if let inputTokens { event["inputTokens"] = inputTokens }
    if let outputTokens { event["outputTokens"] = outputTokens }
    return event
  }
}

// One call of the newest tool-call entry in a session transcript.
private struct PendingToolCall: Sendable {
  let id: String
  let name: String
  let arguments: String
}

// The tool calls of one model turn, from the moment the first one runs until
// the session moves past them. Each call waits until `resume` supplies its result.
private struct ToolRound {
  let token: UUID
  let entryID: String
  let calls: [PendingToolCall]
  var claimed: Set<String> = []
  var results: [String: String]?
  var waiting: [String: CheckedContinuation<String, Error>] = [:]
}

private struct ActiveRequest {
  let id: String
  let token: UUID
  let task: Task<AppleModelCompletion, Error>
  let emit: @Sendable ([String: Any]) -> Void
}

private let toolLog = Logger(subsystem: "KiloAppleModel", category: "tools")

private actor AppleModelEngine {
  // This names the actual public provider selected below, not a guessed device
  // model or a private version identifier (Apple does not expose one).
  private let modelId = "apple-system-language-model"
  private var active: ActiveRequest?
  private var round: ToolRound?

  func availability() -> [String: Any] {
    guard #available(iOS 26.0, *) else {
      return [
        "status": "unavailable", "reason": "unsupported_os", "modelId": modelId,
        "contextWindow": 0, "maxOutputTokens": 0, "systemInstructions": false,
        "tokenCounting": false, "tools": false,
      ]
    }
    let model = SystemLanguageModel.default
    let reason = Self.unavailableReason(model)
    let contextSize = Self.contextSize(model)
    // Tool calling is part of every Foundation Models release (the Tool protocol, iOS 26).
    var result: [String: Any] = [
      "status": reason == nil ? "available" : "unavailable", "modelId": modelId,
      "contextWindow": contextSize, "maxOutputTokens": contextSize,
      "systemInstructions": true, "tokenCounting": false, "tools": true,
    ]
    if #available(iOS 26.4, *) { result["tokenCounting"] = true }
    if let reason { result["reason"] = reason }
    return result
  }

  func countTokens(_ request: AppleModelRequest) async throws -> Int {
    do {
      guard #available(iOS 26.4, *) else {
        throw AppleModelFailure(reason: "token_count_unavailable")
      }
      let model = SystemLanguageModel.default
      if let reason = Self.unavailableReason(model) { throw AppleModelFailure(reason: reason) }
      try Self.validate(request, contextSize: Self.contextSize(model))
      // Count actual role-aware transcript entries, including the latest user
      // prompt, system instructions, and tool definitions, rather than joining
      // their text together. These tools are never called.
      let tools = Self.tools(request.tools, token: UUID(), engine: self, session: SessionReference())
      return try await model.tokenCount(for: Self.entries(request, tools: tools))
    } catch {
      throw AppleModelFailure(reason: Self.safeReason(error))
    }
  }

  func generate(
    _ request: AppleModelRequest,
    emit: @escaping @Sendable ([String: Any]) -> Void
  ) async throws {
    var token: UUID?
    defer {
      if let token, active?.token == token { active = nil }
    }
    do {
      // A request that waits on tool results nobody sends is abandoned: the
      // conversation moved on. Any other running request makes this one busy.
      if let current = active, round?.token == current.token, round?.results == nil {
        await stop(current)
      }
      guard active == nil else { throw AppleModelFailure(reason: "busy") }
      guard #available(iOS 26.0, *) else { throw AppleModelFailure(reason: "unsupported_os") }
      let model = SystemLanguageModel.default
      if let reason = Self.unavailableReason(model) { throw AppleModelFailure(reason: reason) }
      try Self.validate(request, contextSize: Self.contextSize(model))
      let requestToken = UUID()
      token = requestToken
      let task = Task { try await self.infer(request, token: requestToken, model: model, emit: emit) }
      active = ActiveRequest(id: request.id, token: requestToken, task: task, emit: emit)
      let completion = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: {
        task.cancel()
      }
      // cancel/release may win after inference finishes but before this actor
      // resumes. A cancelled request must never emit a successful terminal event.
      try Task.checkCancellation()
      guard !task.isCancelled else { throw CancellationError() }
      emit(completion.event(id: request.id))
    } catch {
      let reason = Self.safeReason(error)
      emit(["id": request.id, "kind": "error", "reason": reason])
      throw AppleModelFailure(reason: reason)
    }
  }

  /// Supplies the results of the tool calls the request waits on. Its
  /// generation then continues and streams on under the same request id.
  func resume(_ id: String, results: [AppleToolResult]) throws {
    guard let current = active, current.id == id, var open = round,
          open.token == current.token, open.results == nil else {
      throw AppleModelFailure(reason: "tool_round_missing")
    }
    var bodies: [String: String] = [:]
    for result in results { bodies[result.callId] = result.body }
    guard open.calls.allSatisfy({ bodies[$0.id] != nil }) else {
      throw AppleModelFailure(reason: "invalid_request")
    }
    let waiting = open.waiting
    open.results = bodies
    open.waiting = [:]
    round = open
    for (callID, continuation) in waiting {
      continuation.resume(returning: bodies[callID] ?? "")
    }
  }

  /// One tool call from the model. The first call of a turn reports every call
  /// of that turn to JavaScript; each call then waits for its own result.
  fileprivate func answer(
    token: UUID,
    name: String,
    arguments: String,
    entry: (id: String, calls: [PendingToolCall])?
  ) async throws -> String {
    guard let current = active, current.token == token, !current.task.isCancelled else {
      throw CancellationError()
    }
    // The session records the turn's calls before it runs them. A call that
    // is not in the newest entry cannot be named to JavaScript.
    guard let entry else { throw AppleModelFailure(reason: "tool_call_unmatched") }
    if round?.token != token || round?.entryID != entry.id {
      round = ToolRound(token: token, entryID: entry.id, calls: entry.calls)
      current.emit([
        "id": current.id, "kind": "toolCalls",
        "calls": entry.calls.map { ["id": $0.id, "name": $0.name, "arguments": $0.arguments] },
      ])
    }
    guard var open = round,
          let call = open.calls.first(where: {
            !open.claimed.contains($0.id) && $0.name == name && $0.arguments == arguments
          }) else {
      throw AppleModelFailure(reason: "tool_call_unmatched")
    }
    open.claimed.insert(call.id)
    round = open
    if let body = open.results?[call.id] { return body }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        round?.waiting[call.id] = continuation
      }
    } onCancel: {
      Task { await self.abandonRound(token) }
    }
  }

  func cancel(_ id: String) async {
    guard let current = active, current.id == id else { return }
    await stop(current)
  }

  func release() async {
    guard let current = active else { return }
    // Await stream termination so the request-scoped LanguageModelSession and
    // its inference resources are dropped before release resolves.
    await stop(current)
  }

  private func stop(_ current: ActiveRequest) async {
    current.task.cancel()
    // A call that waits on JavaScript ends with the request, not with its result.
    abandonRound(current.token)
    _ = await current.task.result
    if active?.token == current.token { active = nil }
  }

  private func abandonRound(_ token: UUID) {
    guard let open = round, open.token == token else { return }
    round = nil
    for continuation in open.waiting.values {
      continuation.resume(throwing: CancellationError())
    }
  }

  @available(iOS 26.0, *)
  private func infer(
    _ request: AppleModelRequest,
    token: UUID,
    model: SystemLanguageModel,
    emit: @escaping @Sendable ([String: Any]) -> Void
  ) async throws -> AppleModelCompletion {
    defer { abandonRound(token) }
    try Task.checkCancellation()
    let reference = SessionReference()
    let tools = Self.tools(request.tools, token: token, engine: self, session: reference)
    let inputEntries = Self.entries(request, tools: tools)
    // The latest user entry is supplied through streamResponse; all earlier
    // entries are supplied verbatim, preserving role boundaries and their order.
    let session = LanguageModelSession(
      model: model, tools: tools, transcript: Transcript(entries: inputEntries.dropLast())
    )
    reference.session = session
    var options = GenerationOptions()
    options.maximumResponseTokens = request.maxTokens
    let prompt = request.messages[request.messages.count - 1].text
    var output = ""
    var refused = false
    do {
      for try await snapshot in session.streamResponse(to: prompt, options: options) {
        try Task.checkCancellation()
        let next = snapshot.content
        // Compare UTF-8 rather than grapheme counts: a later snapshot may add a
        // combining mark to the previous snapshot's final displayed character.
        guard next.utf8.starts(with: output.utf8) else {
          throw AppleModelFailure(reason: "non_append_only_stream")
        }
        let delta = String(decoding: next.utf8.dropFirst(output.utf8.count), as: UTF8.self)
        output = next
        if !delta.isEmpty { emit(["id": request.id, "kind": "delta", "text": delta]) }
      }
    } catch {
      try Task.checkCancellation()
      if Self.isRefusal(error) {
        refused = true
      } else {
        throw error
      }
    }
    try Task.checkCancellation()
    var completion = AppleModelCompletion()
    #if KILO_FOUNDATION_MODELS_USAGE
    if #available(iOS 27.0, *) {
      let usage = session.usage
      completion.inputTokens = usage.input.totalTokenCount
      completion.outputTokens = usage.output.totalTokenCount
      completion.usageSource = "reported"
    }
    #endif
    if completion.usageSource == "unavailable", #available(iOS 26.4, *) {
      // These are provider tokenizer counts, not character-based estimates or
      // reported generation statistics. If accounting fails, inference still
      // succeeds with honestly unavailable usage. The input is the transcript
      // before the answer, so tool calls and outputs of this request count too.
      var consumed = Array(session.transcript)
      while let last = consumed.last, case .response = last { consumed.removeLast() }
      if let input = try? await model.tokenCount(for: consumed),
         let generated = try? await model.tokenCount(for: Prompt(output)) {
        completion.inputTokens = input
        completion.outputTokens = generated
        completion.usageSource = "counted"
      }
    }
    try Task.checkCancellation()
    if refused {
      completion.stop = "refusal"
    } else if completion.usageSource == "reported",
              let outputTokens = completion.outputTokens, outputTokens >= request.maxTokens {
      completion.stop = "maxTokens"
    }
    // maximumResponseTokens silently ends the stream at its ceiling. There is
    // no public finish-reason field. Only reported generation-token usage can
    // establish that the budget was reached. Re-tokenized output may use a
    // different token segmentation, so counted usage keeps stop=unknown.
    return completion
  }

  @available(iOS 26.0, *)
  private static func validate(_ request: AppleModelRequest, contextSize: Int) throws {
    let roles: Set<String> = ["user", "assistant", "toolCalls", "toolOutput"]
    guard !request.id.isEmpty, request.maxTokens > 0, request.maxTokens <= contextSize,
          request.messages.last?.role == "user",
          request.messages.allSatisfy({ roles.contains($0.role) }) else {
      throw AppleModelFailure(reason: "invalid_request")
    }
  }

  /// The offered tools Foundation Models can express. A schema it rejects
  /// leaves that one tool out, so the request still runs with the others.
  @available(iOS 26.0, *)
  private static func tools(
    _ records: [AppleModelTool],
    token: UUID,
    engine: AppleModelEngine,
    session: SessionReference
  ) -> [HarnessTool] {
    records.compactMap { record in
      do {
        let schema = try JSONDecoder().decode(ToolSchema.self, from: Data(record.parameters.utf8))
        let parameters = try GenerationSchema(root: schema.dynamic(name: record.name), dependencies: [])
        return HarnessTool(
          name: record.name, description: record.description, parameters: parameters,
          token: token, engine: engine, session: session
        )
      } catch {
        toolLog.error("Tool left out: \(record.name, privacy: .public)")
        return nil
      }
    }
  }

  @available(iOS 26.0, *)
  private static func entries(
    _ request: AppleModelRequest,
    tools: [HarnessTool]
  ) -> [Transcript.Entry] {
    var entries: [Transcript.Entry] = []
    entries.reserveCapacity(request.messages.count + 1)
    if !request.system.isEmpty || !tools.isEmpty {
      entries.append(.instructions(Transcript.Instructions(
        segments: request.system.isEmpty
          ? [] : [.text(Transcript.TextSegment(content: request.system))],
        toolDefinitions: tools.map { Transcript.ToolDefinition(tool: $0) }
      )))
    }
    for message in request.messages {
      let segments = [Transcript.Segment.text(Transcript.TextSegment(content: message.text))]
      switch message.role {
      case "user":
        entries.append(.prompt(Transcript.Prompt(segments: segments)))
      case "toolCalls":
        entries.append(.toolCalls(Transcript.ToolCalls(message.calls.map { call in
          // Arguments another model wrote may not be JSON; they stay as the text it wrote.
          let arguments = (try? GeneratedContent(json: call.arguments)) ?? GeneratedContent(call.arguments)
          return Transcript.ToolCall(id: call.id, toolName: call.name, arguments: arguments)
        })))
      case "toolOutput":
        entries.append(.toolOutput(Transcript.ToolOutput(
          id: message.callId, toolName: message.name, segments: segments
        )))
      default:
        entries.append(.response(Transcript.Response(assetIDs: [], segments: segments)))
      }
    }
    return entries
  }

  @available(iOS 26.0, *)
  private static func contextSize(_ model: SystemLanguageModel) -> Int {
    if #available(iOS 26.4, *) { return model.contextSize }
    // Apple's documented on-device context ceiling before contextSize existed.
    return 4096
  }

  @available(iOS 26.0, *)
  private static func unavailableReason(_ model: SystemLanguageModel) -> String? {
    switch model.availability {
    case .available: return nil
    case .unavailable(let reason):
      switch reason {
      case .deviceNotEligible: return "device_not_eligible"
      case .appleIntelligenceNotEnabled: return "apple_intelligence_disabled"
      case .modelNotReady: return "model_not_ready"
      @unknown default: return "model_unavailable"
      }
    }
  }

  private static func isRefusal(_ error: Error) -> Bool {
    #if KILO_FOUNDATION_MODELS_USAGE
    if #available(iOS 27.0, *), let error = error as? LanguageModelError {
      if case .refusal = error { return true }
    }
    #endif
    if #available(iOS 26.0, *), let error = error as? LanguageModelSession.GenerationError {
      if case .refusal = error { return true }
    }
    return false
  }

  private static func safeReason(_ error: Error) -> String {
    if error is CancellationError { return "cancelled" }
    if let error = error as? AppleModelFailure { return error.reason }
    #if KILO_FOUNDATION_MODELS_USAGE
    if #available(iOS 27.0, *) {
      if let error = error as? LanguageModelError {
        switch error {
        case .contextSizeExceeded: return "context_window_exceeded"
        case .rateLimited: return "rate_limited"
        case .guardrailViolation: return "guardrail_violation"
        case .refusal: return "refusal"
        case .unsupportedLanguageOrLocale: return "unsupported_language"
        case .timeout: return "timeout"
        default: return "generation_failed"
        }
      }
      if error is SystemLanguageModel.Error { return "model_not_ready" }
      if let error = error as? LanguageModelSession.Error, error == .concurrentRequests {
        return "busy"
      }
    }
    #endif
    // A failed tool call reports why it failed, not that a tool was involved.
    if #available(iOS 26.0, *), let error = error as? LanguageModelSession.ToolCallError {
      return safeReason(error.underlyingError)
    }
    if #available(iOS 26.0, *), let error = error as? LanguageModelSession.GenerationError {
      switch error {
      case .exceededContextWindowSize: return "context_window_exceeded"
      case .assetsUnavailable: return "model_not_ready"
      case .guardrailViolation: return "guardrail_violation"
      case .refusal: return "refusal"
      case .unsupportedLanguageOrLocale: return "unsupported_language"
      case .rateLimited: return "rate_limited"
      case .concurrentRequests: return "busy"
      default: return "generation_failed"
      }
    }
    // Never expose a provider exception's debugDescription, prompt, or output.
    return "generation_failed"
  }
}

// The session a request's tools belong to. Tools are built before their
// session, so this is set once, right after, and read only while it responds.
@available(iOS 26.0, *)
private final class SessionReference: @unchecked Sendable {
  weak var session: LanguageModelSession?

  /// The calls of the newest tool-call entry: the turn the model is in.
  func newestCalls() -> (id: String, calls: [PendingToolCall])? {
    guard let transcript = session?.transcript else { return nil }
    for entry in transcript.reversed() {
      if case .toolCalls(let calls) = entry {
        return (calls.id, calls.map {
          PendingToolCall(id: $0.id, name: $0.toolName, arguments: $0.arguments.jsonString)
        })
      }
    }
    return nil
  }
}

// A harness tool as Foundation Models sees it. The session calls it; the call
// goes to JavaScript, which runs the tool, and the result comes back through
// `resume`. Nothing runs here.
@available(iOS 26.0, *)
private struct HarnessTool: Tool {
  let name: String
  let description: String
  let parameters: GenerationSchema
  let token: UUID
  let engine: AppleModelEngine
  let session: SessionReference

  func call(arguments: GeneratedContent) async throws -> String {
    try await engine.answer(
      token: token, name: name, arguments: arguments.jsonString, entry: session.newestCalls()
    )
  }
}

// The schema tree native-tool-schema.ts sends. JavaScript has already left out
// what DynamicGenerationSchema cannot express; an unknown type still throws here.
private final class ToolSchema: Decodable, Sendable {
  let type: String
  let description: String?
  let choices: [String]?
  let items: ToolSchema?
  let minItems: Int?
  let maxItems: Int?
  let properties: [ToolProperty]?

  // Object and choice schemas need a name; the path keeps nested names unique.
  @available(iOS 26.0, *)
  func dynamic(name: String) throws -> DynamicGenerationSchema {
    switch type {
    case "string":
      if let choices { return DynamicGenerationSchema(name: name, description: description, anyOf: choices) }
      return DynamicGenerationSchema(type: String.self)
    case "integer":
      return DynamicGenerationSchema(type: Int.self)
    case "number":
      return DynamicGenerationSchema(type: Double.self)
    case "boolean":
      return DynamicGenerationSchema(type: Bool.self)
    case "array":
      guard let items else { throw AppleModelFailure(reason: "unsupported_schema") }
      return DynamicGenerationSchema(
        arrayOf: try items.dynamic(name: name + "_item"),
        minimumElements: minItems, maximumElements: maxItems
      )
    case "object":
      return DynamicGenerationSchema(
        name: name, description: description,
        properties: try (properties ?? []).map { property in
          DynamicGenerationSchema.Property(
            name: property.name, description: property.description,
            schema: try property.schema.dynamic(name: name + "_" + property.name),
            isOptional: property.optional
          )
        }
      )
    default:
      throw AppleModelFailure(reason: "unsupported_schema")
    }
  }
}

private struct ToolProperty: Decodable, Sendable {
  let name: String
  let description: String?
  let optional: Bool
  let schema: ToolSchema
}
