@main struct AppleModelRetryTests {
  static func main() {
    let changed = AppleCompletedToolCall(
      id: "set-1", name: "settings_set", arguments: "{\"key\":\"theme\",\"value\":\"dark\"}", body: "saved"
    )
    var mutations = 0
    var retry = AppleModelRetry()
    mutations += 1
    retry.record([changed])
    precondition(!retry.start(reason: "cancelled", hasText: false, pendingResults: false))
    precondition(!retry.start(reason: "context_window_exceeded", hasText: false, pendingResults: false))
    precondition(!retry.start(reason: "token_generation_failed", hasText: true, pendingResults: false))
    precondition(!retry.start(reason: "token_generation_failed", hasText: false, pendingResults: true))
    precondition(retry.start(reason: "token_generation_failed", hasText: false, pendingResults: false))
    precondition(retry.result(name: changed.name, arguments: changed.arguments) == "saved")
    precondition(retry.result(name: changed.name, arguments: changed.arguments) == nil)
    precondition(retry.result(name: "settings_set", arguments: "{\"key\":\"theme\",\"value\":\"light\"}") == nil)
    precondition(retry.result(name: "other_mutation", arguments: changed.arguments) == nil)
    precondition(!retry.start(reason: "token_generation_failed", hasText: false, pendingResults: false))
    retry.record([AppleCompletedToolCall(id: "new", name: "new", arguments: "{}", body: "new")])
    precondition(retry.completedRounds.count == 1)
    precondition(retry.result(name: "new", arguments: "{}") == nil)
    precondition(mutations == 1)

    var multiple = AppleModelRetry()
    multiple.record([changed, AppleCompletedToolCall(
      id: "set-2", name: changed.name, arguments: changed.arguments, body: "saved again"
    )])
    multiple.record([AppleCompletedToolCall(id: "empty", name: "time", arguments: "{}", body: "")])
    precondition(multiple.start(reason: "token_generation_failed", hasText: false, pendingResults: false))
    precondition(multiple.result(name: changed.name, arguments: changed.arguments) == "saved")
    precondition(multiple.result(name: changed.name, arguments: changed.arguments) == "saved again")
    precondition(multiple.result(name: changed.name, arguments: changed.arguments) == nil)
    precondition(multiple.result(name: "time", arguments: "{}") == "")

    var fresh = AppleModelRetry()
    precondition(!fresh.start(reason: "token_generation_failed", hasText: false, pendingResults: false))
    precondition(fresh.result(name: changed.name, arguments: changed.arguments) == nil)
    print("AppleModelRetry: all checks passed; settings_set mutations=\(mutations)")
  }
}
