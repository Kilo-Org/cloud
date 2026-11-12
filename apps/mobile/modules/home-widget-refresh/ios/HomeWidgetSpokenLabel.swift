import Foundation

/// The spoken text of one Home widget timeline entry, built from the values
/// that entry draws.
///
/// The app and the widget extension both produce a timeline entry, and a screen
/// reader must hear the same sentence from either. The app-side rule is
/// `glanceableSpokenText` in `lib/glanceable/presentation.ts`: the status line
/// when one shows, then each count above zero as its figure and label, then the
/// Open agents action, joined with the catalog's own list separator. This file
/// is the extension's side of that rule. It stays Foundation-only so a unit test
/// can compile it, and it reads everything it needs from the config copy the app
/// sends, because the widget process has no formatter and no i18n.
enum HomeWidgetSpokenLabel {
  /// A count in the config copy's own digits and grouping.
  ///
  /// `copy["digits"]` holds the language's ten digits and is empty where it
  /// writes the plain ten; `copy["group"]` holds a one-character thousands
  /// separator and is empty where the language has none or writes a wider one.
  /// Both come from the same app formatter that writes the widget layout's own
  /// counts, so the spoken figure reads like the drawn one.
  static func figure(_ value: Int, copy: [String: String]) -> String {
    let plain = String(max(0, value))
    let separator = copy["group"] ?? ""
    var grouped = ""
    for (index, character) in plain.enumerated() {
      if index > 0, (plain.count - index).isMultiple(of: 3) {
        grouped += separator
      }
      grouped.append(character)
    }
    let table = Array(copy["digits"] ?? "")
    guard table.count == 10 else { return grouped }
    let mapped = grouped.map { character -> Character in
      guard let ascii = character.asciiValue, ascii >= 48, ascii <= 57 else { return character }
      return table[Int(ascii) - 48]
    }
    return String(mapped)
  }

  /// The entry's sentence: the status line it draws, then each count line it
  /// draws that is above zero, then the Open agents action.
  ///
  /// A zero count draws as a row to hold the layout still but says nothing to a
  /// screen reader, and a cleared entry (expired, signed out) passes no rows at
  /// all, so its sentence carries only its status.
  static func text(
    statusLine: String?,
    countLines: [[String: Any]],
    copy: [String: String]
  ) -> String {
    var parts: [String] = []
    if let statusLine, !statusLine.isEmpty {
      parts.append(statusLine)
    }
    for line in countLines {
      guard let count = line["count"] as? Int, count > 0 else { continue }
      let figure = figure(count, copy: copy)
      if let label = line["label"] as? String, !label.isEmpty {
        parts.append("\(figure) \(label)")
      } else {
        parts.append(figure)
      }
    }
    let openAgents = copy["openAgents"] ?? ""
    if !openAgents.isEmpty {
      parts.append(openAgents)
    }
    // A payload from an app that sent no joiner keeps the separator it drew with.
    var joiner = copy["listJoiner"] ?? ""
    if joiner.isEmpty {
      joiner = ", "
    }
    return parts.joined(separator: joiner)
  }

  /// The signed-out wording of the terminal entry, never empty: the copy's own
  /// signed-out string, then the privacy string a payload may carry in its
  /// place, then the layout's own last resort, so the card that explains the
  /// sign-out is never blank and never unlabeled.
  static func signedOutStatus(_ copy: [String: String]) -> String {
    for key in ["signed_out", "privacy"] {
      if let text = copy[key], !text.isEmpty {
        return text
      }
    }
    return "Sign in to see agents"
  }
}