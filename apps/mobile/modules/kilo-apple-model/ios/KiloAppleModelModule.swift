import CoreGraphics
import ExpoModulesCore
import Foundation
import FoundationModels
import ImageIO

// Records are decoded once by Expo and never mutated after crossing into the
// engine actor. No transcript, session, or generated text survives a request.
struct AppleModelImage: Record, @unchecked Sendable {
  @Field var media: String = ""
  @Field var data: String = ""
}

struct AppleModelMessage: Record, @unchecked Sendable {
  @Field var role: String = ""
  @Field var text: String = ""
  @Field var images: [AppleModelImage] = []
}

struct AppleModelRequest: Record, @unchecked Sendable {
  @Field var id: String = ""
  @Field var system: String = ""
  @Field var messages: [AppleModelMessage] = []
  @Field var maxTokens: Int = 0
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

private actor AppleModelEngine {
  // This names the actual public provider selected below, not a guessed device
  // model or a private version identifier (Apple does not expose one).
  private let modelId = "apple-system-language-model"
  private var active: (id: String, token: UUID, task: Task<AppleModelCompletion, Error>)?

  func availability() -> [String: Any] {
    guard #available(iOS 26.0, *) else {
      return [
        "status": "unavailable", "reason": "unsupported_os", "modelId": modelId,
        "contextWindow": 0, "maxOutputTokens": 0, "systemInstructions": false,
        "tokenCounting": false,
      ]
    }
    let model = SystemLanguageModel.default
    let reason = Self.unavailableReason(model)
    let contextSize = Self.contextSize(model)
    var result: [String: Any] = [
      "status": reason == nil ? "available" : "unavailable", "modelId": modelId,
      "contextWindow": contextSize, "maxOutputTokens": contextSize,
      "systemInstructions": true, "tokenCounting": false,
      "images": Self.readsImages(model),
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
      try Self.validate(request, model: model)
      // Count actual role-aware transcript entries, including the latest user
      // prompt and system instructions, rather than joining their text together.
      return try await model.tokenCount(for: Self.entries(request))
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
      guard active == nil else { throw AppleModelFailure(reason: "busy") }
      guard #available(iOS 26.0, *) else { throw AppleModelFailure(reason: "unsupported_os") }
      let model = SystemLanguageModel.default
      if let reason = Self.unavailableReason(model) { throw AppleModelFailure(reason: reason) }
      try Self.validate(request, model: model)
      let requestToken = UUID()
      token = requestToken
      let task = Task { try await self.infer(request, model: model, emit: emit) }
      active = (request.id, requestToken, task)
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

  func cancel(_ id: String) async {
    guard let current = active, current.id == id else { return }
    current.task.cancel()
    _ = await current.task.result
    if active?.token == current.token { active = nil }
  }

  func release() async {
    guard let current = active else { return }
    current.task.cancel()
    // Await stream termination so the request-scoped LanguageModelSession and
    // its inference resources are dropped before release resolves.
    _ = await current.task.result
    if active?.token == current.token { active = nil }
  }

  @available(iOS 26.0, *)
  private func infer(
    _ request: AppleModelRequest,
    model: SystemLanguageModel,
    emit: @escaping @Sendable ([String: Any]) -> Void
  ) async throws -> AppleModelCompletion {
    try Task.checkCancellation()
    let inputEntries = try Self.entries(request)
    // The latest user entry is supplied through streamResponse; all earlier
    // entries are supplied verbatim, preserving role boundaries and their order.
    let session = LanguageModelSession(
      model: model, tools: [], transcript: Transcript(entries: inputEntries.dropLast())
    )
    var options = GenerationOptions()
    options.maximumResponseTokens = request.maxTokens
    // validate guarantees the last message, and so the last entry, is the user's.
    let lastText = request.messages[request.messages.count - 1].text
    let prompt = Self.prompt(of: inputEntries[inputEntries.count - 1], text: lastText)
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
      // succeeds with honestly unavailable usage.
      if let input = try? await model.tokenCount(for: inputEntries),
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
  private static func validate(_ request: AppleModelRequest, model: SystemLanguageModel) throws {
    guard !request.id.isEmpty, request.maxTokens > 0, request.maxTokens <= contextSize(model),
          request.messages.last?.role == "user",
          request.messages.allSatisfy({ $0.role == "user" || $0.role == "assistant" }),
          request.messages.allSatisfy({ $0.role == "user" || $0.images.isEmpty }) else {
      throw AppleModelFailure(reason: "invalid_request")
    }
    if !readsImages(model), request.messages.contains(where: { !$0.images.isEmpty }) {
      throw AppleModelFailure(reason: "images_unsupported")
    }
  }

  /// Apple's public vision capability, never a guess from the device or OS
  /// alone. SDK 27 adds the query and image attachments; older SDKs and
  /// iOS 26 read no images.
  @available(iOS 26.0, *)
  private static func readsImages(_ model: SystemLanguageModel) -> Bool {
    #if KILO_FOUNDATION_MODELS_USAGE
    if #available(iOS 27.0, *) { return model.capabilities.contains(.vision) }
    #endif
    return false
  }

  @available(iOS 26.0, *)
  private static func entries(_ request: AppleModelRequest) throws -> [Transcript.Entry] {
    var entries: [Transcript.Entry] = []
    entries.reserveCapacity(request.messages.count + 1)
    if !request.system.isEmpty {
      entries.append(.instructions(Transcript.Instructions(
        segments: [.text(Transcript.TextSegment(content: request.system))], toolDefinitions: []
      )))
    }
    for message in request.messages {
      let segments = try imageSegments(message) + [
        Transcript.Segment.text(Transcript.TextSegment(content: message.text)),
      ]
      if message.role == "user" {
        entries.append(.prompt(Transcript.Prompt(segments: segments)))
      } else {
        entries.append(.response(Transcript.Response(assetIDs: [], segments: segments)))
      }
    }
    return entries
  }

  /// Decoded once per request. `validate` has already refused images for a
  /// model or SDK that reads none.
  @available(iOS 26.0, *)
  private static func imageSegments(_ message: AppleModelMessage) throws -> [Transcript.Segment] {
    #if KILO_FOUNDATION_MODELS_USAGE
    if #available(iOS 27.0, *) {
      return try message.images.map { image in
        guard image.media.hasPrefix("image/"), let data = Data(base64Encoded: image.data),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
          throw AppleModelFailure(reason: "invalid_image")
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let orientation = (properties?[kCGImagePropertyOrientation] as? UInt32)
          .flatMap(CGImagePropertyOrientation.init(rawValue:))
        return .attachment(Transcript.AttachmentSegment(
          content: .image(Transcript.ImageAttachment(cgImage, orientation: orientation))
        ))
      }
    }
    #endif
    return []
  }

  /// The latest user message as a prompt, with the images already decoded
  /// into its transcript entry.
  @available(iOS 26.0, *)
  private static func prompt(of entry: Transcript.Entry, text: String) -> Prompt {
    #if KILO_FOUNDATION_MODELS_USAGE
    if #available(iOS 27.0, *), case .prompt(let prompt) = entry {
      let images = prompt.segments.compactMap { segment -> FoundationModels.Attachment<ImageAttachmentContent>? in
        guard case .attachment(let attachment) = segment,
              case .image(let image) = attachment.content else { return nil }
        return FoundationModels.Attachment(image.cgImage, orientation: image.orientation)
      }
      if !images.isEmpty {
        return Prompt {
          images
          text
        }
      }
    }
    #endif
    return Prompt(text)
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
