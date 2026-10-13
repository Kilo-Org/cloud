enum AppleModelBudget {
  static func outputCeiling(contextSize: Int) -> Int {
    contextSize / 2
  }

  // Tool outputs arrive after generation starts; leave one eighth of the
  // window for them and for framing not represented by the tokenizer count.
  static func responseLimit(requested: Int, contextSize: Int, inputTokens: Int) -> Int? {
    let available = contextSize - inputTokens - contextSize / 8
    let limit = min(requested, outputCeiling(contextSize: contextSize), available)
    return limit > 0 ? limit : nil
  }
}
