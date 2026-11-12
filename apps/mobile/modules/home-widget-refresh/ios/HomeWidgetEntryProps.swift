import Foundation

/// The props of one Home widget timeline entry, built from the phase that entry
/// draws.
///
/// The rebuild runs in the extension, so this assembly has to be provable
/// without WidgetKit: it takes the retained base props, the phase's Home
/// presentation and the config copy as plain dictionaries, and it returns plain
/// dictionaries. `HomeWidgetEntryPropsTests` holds it to the same sentences the
/// app's shared spoken label produces.
enum HomeWidgetEntryProps {
  /// A refreshed entry: the phase's presentation over the retained base props.
  ///
  /// The spoken label is built last, from the values this entry ends up with,
  /// so a phase whose counts are cleared (an expired entry) can never announce
  /// a count it does not draw.
  static func refreshed(
    base: [String: Any],
    presentation: [String: Any],
    snapshot: [String: Any],
    copy: [String: String],
    at: Double,
    expires: Double?
  ) -> [String: Any] {
    var props = base
    props["home"] = presentation
    var counts = presentation["secondaryCounts"] as? [[String: Any]] ?? []
    if let kind = presentation["primaryKind"] as? String,
       let count = presentation["primaryCount"] as? Int, count > 0 {
      counts.insert(["kind": kind, "count": count], at: 0)
    }
    props["countLines"] = counts.map { count -> [String: Any] in
      var line = count
      line["label"] = copy[count["kind"] as? String ?? ""] ?? ""
      return line
    }
    props["primaryKind"] = presentation["primaryKind"]
    props["primaryCount"] = presentation["primaryCount"]
    props["primaryLabel"] = copy[presentation["primaryKind"] as? String ?? ""]
    let status = presentation["status"] as? String ?? "waiting"
    props["statusLine"] = status == "content" ? nil : copy[status]
    if let expires, at >= expires {
      props["countLines"] = []
      props["primaryKind"] = nil
      props["primaryCount"] = 0
      props["primaryLabel"] = nil
      props["statusLine"] = copy["expired"]
    }
    props["actions"] = [
      "approve": presentation["canApprove"] as? Bool ?? false,
      "newAgent": presentation["canCreate"] as? Bool ?? false,
    ]
    props["needsInputSince"] = snapshot["needsInputSince"]
    props["scheduledAt"] = presentation["scheduledAt"]
    props["newestTitle"] = nil
    props["actionFeedback"] = nil
    props["accessibilityLabel"] = HomeWidgetSpokenLabel.text(
      statusLine: props["statusLine"] as? String,
      countLines: props["countLines"] as? [[String: Any]] ?? [],
      copy: copy
    )
    return props
  }

  /// The one entry an authentication refusal leaves behind: the signed-out
  /// status, no counts, no actions, and that same sentence as its spoken label,
  /// so the card that explains the sign-out is never blank and never unlabeled.
  static func terminal(copy: [String: String]) -> [String: Any] {
    let status = HomeWidgetSpokenLabel.signedOutStatus(copy)
    return [
      "statusLine": status,
      "countLines": [],
      "primaryCount": 0,
      "actions": ["approve": false, "newAgent": false],
      "accessibilityLabel": status,
    ]
  }
}