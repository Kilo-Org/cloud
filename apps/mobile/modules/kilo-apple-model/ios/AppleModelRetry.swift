struct AppleCompletedToolCall: Sendable {
  let id: String
  let name: String
  let arguments: String
  let body: String
}

struct AppleModelRetry {
  private(set) var completedRounds: [[AppleCompletedToolCall]] = []
  private(set) var replaying = false

  mutating func record(_ calls: [AppleCompletedToolCall]) {
    if !replaying { completedRounds.append(calls) }
  }

  mutating func start(reason: String, hasText: Bool, pendingResults: Bool) -> Bool {
    guard reason == "token_generation_failed" || reason == "empty_response",
          !hasText, !pendingResults, !replaying, !completedRounds.isEmpty else { return false }
    replaying = true
    return true
  }

}
