import Foundation

/**
 * One launcher action: the deep-link url a tap opens, with the label that names
 * it. They travel together because a shortcut needs both — JS translates the
 * label — so a url with no label has no title to show.
 */
struct LauncherSurfacesAction: Equatable {
  let url: String
  let label: String
}

/**
 * The launcher surfaces payload frozen by the JS side
 * (`src/lib/native-launcher-surfaces.ts`): the Home Screen Quick Actions to
 * publish.
 *
 * New agent is required because it is the one action sign-out keeps: clearing
 * the dynamic surfaces rebuilds the launcher from the cached payload's New agent
 * action alone. JS always sends it, so a payload without it is not one this
 * module can honour, and `init?(json:)` rejects it before anything is cached.
 *
 * Needs input and Open last session are dynamic — Needs input exists only while
 * an agent waits — so each is present only when both its url and label arrive.
 */
struct KiloLauncherSurfacesPayload: Equatable {
  let newAgent: LauncherSurfacesAction
  let needsInput: LauncherSurfacesAction?
  let openLastSession: LauncherSurfacesAction?

  init?(json: String) {
    guard let data = json.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let object = parsed as? [String: Any] else {
      return nil
    }
    guard let newAgent = Self.action(
      object,
      urlKey: "newAgentUrl",
      labelKey: "newAgentLabel"
    ) else {
      return nil
    }
    self.newAgent = newAgent
    needsInput = Self.action(object, urlKey: "needsInputUrl", labelKey: "needsInputLabel")
    openLastSession = Self.action(
      object,
      urlKey: "openLastSessionUrl",
      labelKey: "openLastSessionLabel"
    )
  }

  private static func action(
    _ object: [String: Any],
    urlKey: String,
    labelKey: String
  ) -> LauncherSurfacesAction? {
    guard let url = payloadString(object, urlKey),
          let label = payloadString(object, labelKey) else {
      return nil
    }
    return LauncherSurfacesAction(url: url, label: label)
  }
}

/** Reads a payload string, treating an explicit JSON null or an empty string as absent. */
private func payloadString(_ object: [String: Any], _ key: String) -> String? {
  guard let value = object[key] as? String, !value.isEmpty else {
    return nil
  }
  return value
}
