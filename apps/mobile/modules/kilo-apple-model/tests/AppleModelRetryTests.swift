@main struct AppleModelRetryTests {
  static func main() {
    let changed = AppleCompletedToolCall(
      id: "set-1", name: "settings_set", arguments: "{\"setting\":\"theme\",\"value\":\"dark\"}", body: "saved"
    )
    for reason in ["token_generation_failed", "empty_response"] {
      var recovery = AppleModelRetry()
      precondition(!recovery.start(reason: reason, hasText: false, pendingResults: false))
      recovery.record([changed])
      precondition(!recovery.start(reason: reason, hasText: true, pendingResults: false))
      precondition(!recovery.start(reason: reason, hasText: false, pendingResults: true))
      precondition(recovery.start(reason: reason, hasText: false, pendingResults: false))
      precondition(recovery.replaying)
      precondition(recovery.completedRounds[0][0].body == "saved")
      precondition(!recovery.start(reason: reason, hasText: false, pendingResults: false))
      recovery.record([AppleCompletedToolCall(id: "later", name: "time", arguments: "{}", body: "later")])
      precondition(recovery.completedRounds.count == 1)
    }
    for reason in ["cancelled", "context_window_exceeded", "refusal", "guardrail_violation", "busy"] {
      var recovery = AppleModelRetry()
      recovery.record([changed])
      precondition(!recovery.start(reason: reason, hasText: false, pendingResults: false))
      precondition(!recovery.replaying)
    }
    var parallel = AppleModelRetry()
    parallel.record([changed, AppleCompletedToolCall(id: "clock", name: "time", arguments: "{}", body: "noon")])
    parallel.record([AppleCompletedToolCall(id: "list", name: "settings_list", arguments: "{}", body: "settings")])
    precondition(parallel.start(reason: "token_generation_failed", hasText: false, pendingResults: false))
    precondition(parallel.completedRounds.map { $0.map(\.id) } == [["set-1", "clock"], ["list"]])
    print("AppleModelRetry: all checks passed")
  }
}
