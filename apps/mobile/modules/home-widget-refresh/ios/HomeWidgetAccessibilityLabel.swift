import Foundation

/// Builds the Home widget entry's spoken label from the rendered props.
///
/// Two callers use it: the widget refresh rebuild and the 401 terminal entry.
/// The widget process has no number formatter and no app bundle, so the input
/// must carry the locale digits, the grouping separator, the list joiner and
/// every copy string.
func homeWidgetAccessibilityLabel(_ input: [String: Any]) -> String {
  let digits = input["digits"] as? String ?? ""
  let group = input["group"] as? String ?? ","
  let joiner = input["listJoiner"] as? String ?? ""
  var parts: [String] = []
  if let status = trimmed(input["statusLine"] as? String) {
    parts.append(status)
  }
  for line in input["countLines"] as? [[String: Any]] ?? [] {
    guard let count = line["count"] as? Int, count > 0 else { continue }
    parts.append("\(formattedCount(count, group: group, digits: digits)) \(line["label"] as? String ?? "")")
  }
  if let openAgents = trimmed(input["openAgents"] as? String) {
    parts.append(openAgents)
  }
  return parts.joined(separator: joiner)
}

/// The text with leading and trailing whitespace removed, or nil when it holds no other content.
private func trimmed(_ value: String?) -> String? {
  guard let value else { return nil }
  let stripped = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return stripped.isEmpty ? nil : stripped
}

/// The count as plain decimal digits, grouped and then mapped through the locale digits.
/// A digits string of any length other than ten leaves the ASCII digits in place.
private func formattedCount(_ value: Int, group: String, digits: String) -> String {
  let characters = Array(String(value))
  var grouped = ""
  for index in characters.indices {
    if index > 0 && (characters.count - index) % 3 == 0 {
      grouped += group
    }
    grouped.append(characters[index])
  }
  guard digits.count == 10 else { return grouped }
  let localeDigits = Array(digits)
  var localized = ""
  for character in grouped {
    if character.isASCII, let digit = character.wholeNumberValue, digit >= 0, digit <= 9 {
      localized.append(localeDigits[digit])
    } else {
      localized.append(character)
    }
  }
  return localized
}
