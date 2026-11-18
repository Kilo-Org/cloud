@main struct AppleModelBudgetTests {
  static func main() {
    precondition(AppleModelBudget.outputCeiling(contextSize: 4096) == 2048)
    precondition(AppleModelBudget.outputCeiling(contextSize: 8192) == 4096)
    precondition(AppleModelBudget.responseLimit(requested: 4096, contextSize: 4096, inputTokens: 100) == 2048)
    precondition(AppleModelBudget.responseLimit(requested: 256, contextSize: 4096, inputTokens: 100) == 256)
    precondition(AppleModelBudget.responseLimit(requested: 4096, contextSize: 4096, inputTokens: 3000) == 584)
    precondition(AppleModelBudget.responseLimit(requested: 4096, contextSize: 4096, inputTokens: 3583) == 1)
    precondition(AppleModelBudget.responseLimit(requested: 4096, contextSize: 4096, inputTokens: 3584) == nil)
    precondition(AppleModelBudget.responseLimit(requested: 4096, contextSize: 4096, inputTokens: 5000) == nil)
    precondition(AppleModelBudget.responseLimit(requested: 0, contextSize: 4096, inputTokens: 100) == nil)
    for inputTokens in 0...5000 {
      if let limit = AppleModelBudget.responseLimit(requested: 4096, contextSize: 4096, inputTokens: inputTokens) {
        precondition(limit > 0 && limit <= 2048)
        precondition(limit + inputTokens + 512 <= 4096)
      }
    }
    print("AppleModelBudget: all checks passed")
  }
}
