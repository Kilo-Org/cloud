import Foundation

/// Bridges the core's session decisions to JavaScript events.
final class JsSessionHandler: SessionHandler, @unchecked Sendable {
  private let sessionId: String
  private let requestHostKey: @Sendable (HostKeyRequest) async -> Bool
  private let requestPrompts: @Sendable (KeyboardInteractiveRequest) async -> PromptReply
  private let notifyDisconnect: @Sendable (DisconnectNotice) -> Void
  private let requestIds: IdSequence

  init(
    sessionId: String,
    requestIds: IdSequence,
    requestHostKey: @escaping @Sendable (HostKeyRequest) async -> Bool,
    requestPrompts: @escaping @Sendable (KeyboardInteractiveRequest) async -> PromptReply,
    notifyDisconnect: @escaping @Sendable (DisconnectNotice) -> Void
  ) {
    self.sessionId = sessionId
    self.requestIds = requestIds
    self.requestHostKey = requestHostKey
    self.requestPrompts = requestPrompts
    self.notifyDisconnect = notifyDisconnect
  }

  func verifyHostKey(
    host: String,
    port: UInt16,
    algorithm: String,
    publicKeyBase64: String,
    fingerprintSha256: String
  ) async -> Bool {
    await requestHostKey(
      HostKeyRequest(
        sessionId: sessionId,
        requestId: requestIds.next(),
        host: host,
        port: Int(port),
        algorithm: algorithm,
        publicKeyBase64: publicKeyBase64,
        fingerprintSha256: fingerprintSha256
      )
    )
  }

  func keyboardInteractive(
    name: String,
    instructions: String,
    prompts: [Prompt]
  ) async -> [String]? {
    let reply = await requestPrompts(
      KeyboardInteractiveRequest(
        sessionId: sessionId,
        requestId: requestIds.next(),
        name: name,
        instructions: instructions,
        prompts: prompts.map { PromptPayload(text: $0.text, echo: $0.echo) }
      )
    )

    switch reply {
    case .answers(let answers):
      return answers
    case .cancelled:
      return nil
    }
  }

  func onDisconnect(reason: String) {
    notifyDisconnect(DisconnectNotice(sessionId: sessionId, reason: reason))
  }
}
