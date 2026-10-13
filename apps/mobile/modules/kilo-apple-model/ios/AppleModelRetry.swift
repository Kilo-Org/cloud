struct AppleCompletedToolCall: Sendable {
  let id: String
  let name: String
  let arguments: String
  let body: String
}

struct AppleModelRetry {
  private(set) var completedRounds: [[AppleCompletedToolCall]] = []
  private(set) var replaying = false
  private var consumed: Set<String> = []

  mutating func record(_ calls: [AppleCompletedToolCall]) {
    if !replaying { completedRounds.append(calls) }
  }

  mutating func start(reason: String, hasText: Bool, pendingResults: Bool) -> Bool {
    guard reason == "token_generation_failed", !hasText, !pendingResults,
          !replaying, !completedRounds.isEmpty else { return false }
    replaying = true
    return true
  }

  // Replay never authorizes a new tool operation, even when the model changes
  // arguments or repeats a completed operation more times than it ran.
  mutating func result(name: String, arguments: String) -> String? {
    guard replaying else { return nil }
    for calls in completedRounds {
      for call in calls where !consumed.contains(call.id) && call.name == name && call.arguments == arguments {
        consumed.insert(call.id)
        return call.body
      }
    }
    return nil
  }
}
