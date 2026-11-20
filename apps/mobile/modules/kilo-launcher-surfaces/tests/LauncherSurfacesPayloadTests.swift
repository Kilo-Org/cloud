/** The valid base payload (New agent only) plus one caller-supplied JSON fragment. */
private func payloadJSON(adding fragment: String = "") -> String {
  let extra = fragment.isEmpty ? "" : ",\n    " + fragment
  return """
    {
      "newAgentUrl": "kiloapp://agent/new",
      "newAgentLabel": "New agent"\(extra)
    }
    """
}

@main struct LauncherSurfacesPayloadTests {
  static func main() {
    let full = KiloLauncherSurfacesPayload(json: payloadJSON(adding: """
      "needsInputUrl": "kiloapp://agent/waiting",
      "needsInputLabel": "Needs input",
      "openLastSessionUrl": "kiloapp://agent/recent",
      "openLastSessionLabel": "Open last session"
      """))
    precondition(
      full?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "a full payload yields the New agent action"
    )
    precondition(
      full?.needsInput == LauncherSurfacesAction(
        url: "kiloapp://agent/waiting",
        label: "Needs input"
      ),
      "a full payload yields the Needs input action"
    )
    precondition(
      full?.openLastSession == LauncherSurfacesAction(
        url: "kiloapp://agent/recent",
        label: "Open last session"
      ),
      "a full payload yields the Open last session action"
    )

    precondition(
      KiloLauncherSurfacesPayload(json: #"{"newAgentLabel": "New agent"}"#) == nil,
      "a payload without newAgentUrl is rejected"
    )
    precondition(
      KiloLauncherSurfacesPayload(
        json: #"{"newAgentUrl": null, "newAgentLabel": "New agent"}"#
      ) == nil,
      "a null newAgentUrl is rejected"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: #"{"newAgentUrl": "", "newAgentLabel": "New agent"}"#) == nil,
      "an empty newAgentUrl is rejected"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: #"{"newAgentUrl": "kiloapp://agent/new"}"#) == nil,
      "a payload without newAgentLabel is rejected"
    )
    precondition(
      KiloLauncherSurfacesPayload(
        json: #"{"newAgentUrl": "kiloapp://agent/new", "newAgentLabel": null}"#
      ) == nil,
      "a null newAgentLabel is rejected"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: #"{"newAgentUrl": "kiloapp://agent/new", "newAgentLabel": ""}"#) == nil,
      "an empty newAgentLabel is rejected"
    )

    precondition(KiloLauncherSurfacesPayload(json: "[1, 2, 3]") == nil, "an array is rejected")
    precondition(
      KiloLauncherSurfacesPayload(json: #""kiloapp://agent/new""#) == nil,
      "a bare string is rejected"
    )
    precondition(KiloLauncherSurfacesPayload(json: "not json") == nil, "non-JSON text is rejected")

    let newAgentOnly = KiloLauncherSurfacesPayload(json: payloadJSON())
    precondition(
      newAgentOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "a payload with only the New agent action keeps it"
    )
    precondition(newAgentOnly?.needsInput == nil, "an absent Needs input pair yields no action")
    precondition(newAgentOnly?.openLastSession == nil, "an absent Open last session pair yields no action")

    let needsInputUrlOnly = KiloLauncherSurfacesPayload(json: payloadJSON(adding: """
      "needsInputUrl": "kiloapp://agent/waiting"
      """))
    precondition(
      needsInputUrlOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "an unpaired Needs input url leaves the New agent action alone"
    )
    precondition(
      needsInputUrlOnly?.needsInput == nil,
      "a needsInputUrl without its label yields no Needs input action"
    )

    let needsInputLabelOnly = KiloLauncherSurfacesPayload(
      json: payloadJSON(adding: #""needsInputLabel": "Needs input""#)
    )
    precondition(
      needsInputLabelOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "an unpaired Needs input label leaves the New agent action alone"
    )
    precondition(
      needsInputLabelOnly?.needsInput == nil,
      "a needsInputLabel without its url yields no Needs input action"
    )

    let needsInputNonStringLabel = KiloLauncherSurfacesPayload(json: payloadJSON(adding: """
      "needsInputUrl": "kiloapp://agent/waiting",
      "needsInputLabel": 42
      """))
    precondition(
      needsInputNonStringLabel?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "a non-string Needs input label leaves the New agent action alone"
    )
    precondition(
      needsInputNonStringLabel?.needsInput == nil,
      "a non-string needsInputLabel yields no Needs input action"
    )

    let openLastSessionUrlOnly = KiloLauncherSurfacesPayload(json: payloadJSON(adding: """
      "openLastSessionUrl": "kiloapp://agent/recent"
      """))
    precondition(
      openLastSessionUrlOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "an unpaired Open last session url leaves the New agent action alone"
    )
    precondition(
      openLastSessionUrlOnly?.openLastSession == nil,
      "an openLastSessionUrl without its label yields no Open last session action"
    )

    let openLastSessionLabelOnly = KiloLauncherSurfacesPayload(
      json: payloadJSON(adding: #""openLastSessionLabel": "Open last session""#)
    )
    precondition(
      openLastSessionLabelOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "an unpaired Open last session label leaves the New agent action alone"
    )
    precondition(
      openLastSessionLabelOnly?.openLastSession == nil,
      "an openLastSessionLabel without its url yields no Open last session action"
    )

    let openLastSessionEmptyUrl = KiloLauncherSurfacesPayload(json: payloadJSON(adding: """
      "openLastSessionUrl": "",
      "openLastSessionLabel": "Open last session"
      """))
    precondition(
      openLastSessionEmptyUrl?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "an empty Open last session url leaves the New agent action alone"
    )
    precondition(
      openLastSessionEmptyUrl?.openLastSession == nil,
      "an empty openLastSessionUrl yields no Open last session action"
    )

    let withExtras = KiloLauncherSurfacesPayload(json: payloadJSON(adding: """
      "unexpected": { "nested": [1, 2] },
      "publishedAt": 1763000000
      """))
    precondition(
      withExtras?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "unknown keys do not disturb the New agent action"
    )
    precondition(withExtras?.needsInput == nil, "unknown keys do not invent a Needs input action")
    precondition(withExtras?.openLastSession == nil, "unknown keys do not invent an Open last session action")

    print("KiloLauncherSurfacesPayload: all checks passed")
  }
}
