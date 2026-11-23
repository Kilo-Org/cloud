import Foundation

/// The account/organization scope this installation is leaving, captured under
/// the same lock that replaces it.
struct HomeWidgetRetiredScope {
  let config: [String: Any]
  let token: String
}

/// What a configure does with the scope already stored.
enum HomeWidgetConfigureScope {
  /// The same account and organization: the stored credential and widget data stay.
  case keep
  /// A different account or organization, or nothing stored yet: replace the
  /// stored scope, retiring the previous registration first when there is one.
  case replace(retire: HomeWidgetRetiredScope?)
}

/// True when the stored scope differs from the incoming one. A store that holds
/// no scope yet is replaced too: the first configure of a process still
/// supersedes whatever a terminal response left behind.
func homeWidgetConfigureScope(
  previous: [String: Any]?,
  token: String?,
  config: [String: Any]
) -> HomeWidgetConfigureScope {
  if let previous,
     previous["scopeKey"] as? String == config["scopeKey"] as? String,
     previous["accountEpoch"] as? Int == config["accountEpoch"] as? Int {
    return .keep
  }
  guard let previous, let token else { return .replace(retire: nil) }
  return .replace(retire: HomeWidgetRetiredScope(config: previous, token: token))
}
