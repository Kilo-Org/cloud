import Foundation

/// A value an App Intent receives from Siri or Shortcuts, as the app's pipeline
/// should see it.
///
/// Every entry point treats a blank value as absent: the start intent omits the
/// payload field, the entity query lists its suggestions, and the visible-session
/// publisher clears the on-screen activity. The rule lives here once, so those
/// three answers cannot drift.
enum KiloAppActionValue {
  /// `value` without its surrounding whitespace and newlines, or nil when
  /// nothing is left.
  static func nonBlank(_ value: String?) -> String? {
    guard let value else {
      return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
