// Compiles and runs with the builder alone:
// swiftc -parse-as-library ios/HomeWidgetConfigureScope.swift tests/HomeWidgetConfigureScopeTests.swift
@main struct HomeWidgetConfigureScopeTests {
  static func main() {
    let previous: [String: Any] = [
      "scopeKey": "org:one",
      "accountEpoch": 7,
      "endpoint": "https://app.kilo.example/api/mobile/widgets",
      "token": "credential-one",
      "organizationId": "org-1",
    ]
    let next: [String: Any] = [
      "scopeKey": "org:two",
      "accountEpoch": 7,
      "endpoint": "https://app.kilo.example/api/mobile/widgets/active-agent",
    ]

    // Same account and organization: the credential and the widget data stay.
    guard case .keep = homeWidgetConfigureScope(
      previous: previous,
      token: "token-one",
      config: ["scopeKey": "org:one", "accountEpoch": 7]
    ) else { preconditionFailure("the same scope must be kept") }
    guard case .keep = homeWidgetConfigureScope(
      previous: previous,
      token: nil,
      config: ["scopeKey": "org:one", "accountEpoch": 7]
    ) else { preconditionFailure("the same scope must be kept without a token too") }

    // Nothing stored yet: replace, with nothing to retire.
    guard case .replace(let none) = homeWidgetConfigureScope(
      previous: nil,
      token: "token-one",
      config: next
    ) else { preconditionFailure("a missing scope must be replaced") }
    precondition(none == nil)

    // An organization change retires the previous scope's registration.
    guard case .replace(let organization) = homeWidgetConfigureScope(
      previous: previous,
      token: "token-one",
      config: next
    ) else { preconditionFailure("a changed scope must be replaced") }
    guard let organization else { preconditionFailure("a changed scope must retire its registration") }
    precondition(organization.token == "token-one")
    precondition(organization.config["scopeKey"] as? String == "org:one")
    // The retirement posts with the replaced scope's own stored credential, so the
    // captured configuration must still carry everything that request needs.
    precondition(organization.config["token"] as? String == "credential-one")
    precondition(organization.config["endpoint"] as? String == "https://app.kilo.example/api/mobile/widgets")
    precondition(organization.config["organizationId"] as? String == "org-1")

    // A stored scope predating the credential field still retires with the
    // separately captured widget token, and adds no credential of its own.
    var credentialless = previous
    credentialless.removeValue(forKey: "token")
    guard case .replace(let legacyCredential) = homeWidgetConfigureScope(
      previous: credentialless,
      token: "token-one",
      config: next
    ) else { preconditionFailure("a changed scope must be replaced") }
    precondition(legacyCredential?.token == "token-one")
    precondition(legacyCredential?.config["token"] as? String == nil)
    precondition(legacyCredential?.config["endpoint"] as? String == "https://app.kilo.example/api/mobile/widgets")

    // An account epoch change alone retires it too.
    guard case .replace(let epoch) = homeWidgetConfigureScope(
      previous: previous,
      token: "token-one",
      config: ["scopeKey": "org:one", "accountEpoch": 8]
    ) else { preconditionFailure("a changed epoch must be replaced") }
    precondition(epoch?.token == "token-one")

    // A previous scope with no registration, or a malformed one, replaces without retiring.
    guard case .replace(let unregistered) = homeWidgetConfigureScope(
      previous: previous,
      token: nil,
      config: next
    ) else { preconditionFailure("a changed scope must be replaced") }
    precondition(unregistered == nil)

    var legacy = previous
    legacy.removeValue(forKey: "accountEpoch")
    guard case .replace(let missingEpoch) = homeWidgetConfigureScope(
      previous: legacy,
      token: "token-one",
      config: ["scopeKey": "org:one", "accountEpoch": 7]
    ) else { preconditionFailure("a scope without an epoch must be replaced") }
    precondition(missingEpoch?.token == "token-one")

    var stringEpoch = previous
    stringEpoch["accountEpoch"] = "7"
    guard case .replace(let typedEpoch) = homeWidgetConfigureScope(
      previous: stringEpoch,
      token: "token-one",
      config: ["scopeKey": "org:one", "accountEpoch": 7]
    ) else { preconditionFailure("a string epoch must be replaced") }
    precondition(typedEpoch?.token == "token-one")

    print("HomeWidgetConfigureScope: all checks passed")
  }
}
