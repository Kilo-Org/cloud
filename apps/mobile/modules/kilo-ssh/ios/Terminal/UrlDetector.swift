import Foundation

enum UrlDetector {
  private static let pattern: NSRegularExpression = {
    guard let pattern = try? NSRegularExpression(pattern: #"https?://[^\s"'<>\[\]{}|\\^`]+"#) else {
      fatalError("Unsupported terminal URL pattern")
    }
    return pattern
  }()

  private static let trailingPunctuation: Set<Character> = [".", ",", ":", ";", ")", "]", "}", "!"]

  static func find(_ line: String, column: Int) -> String? {
    let text = line as NSString
    let range = NSRange(location: 0, length: text.length)
    guard let match = pattern.matches(in: line, range: range)
      .first(where: { NSLocationInRange(column, $0.range) }) else {
      return nil
    }

    var url = text.substring(with: match.range)
    while let last = url.last, trailingPunctuation.contains(last) {
      url.removeLast()
    }
    return url.count > "https://".count ? url : nil
  }
}
