@main struct LauncherSurfacesPayloadTests {
  static func main() {
    let full = KiloLauncherSurfacesPayload(json: """
      {
        "newAgentUrl": "kiloapp://agent/new",
        "newAgentLabel": "New agent",
        "needsInputUrl": "kiloapp://agent/waiting",
        "needsInputLabel": "Needs input",
        "openLastSessionUrl": "kiloapp://agent/recent",
        "openLastSessionLabel": "Open last session"
      }
      """)
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

    let newAgentOnly = KiloLauncherSurfacesPayload(
      json: #"{"newAgentUrl": "kiloapp://agent/new", "newAgentLabel": "New agent"}"#
    )
    precondition(
      newAgentOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "a payload with only the New agent action keeps it"
    )
    precondition(newAgentOnly?.needsInput == nil, "an absent Needs input pair yields no action")
    precondition(newAgentOnly?.openLastSession == nil, "an absent Open last session pair yields no action")

    let needsInputUrlOnly = KiloLauncherSurfacesPayload(json: """
      {
        "newAgentUrl": "kiloapp://agent/new",
        "newAgentLabel": "New agent",
        "needsInputUrl": "kiloapp://agent/waiting"
      }
      """)
    precondition(
      needsInputUrlOnly?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "an unpaired Needs input url leaves the New agent action alone"
    )
    precondition(
      needsInputUrlOnly?.needsInput == nil,
      "a needsInputUrl without its label yields no Needs input action"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: """
        {
          "newAgentUrl": "kiloapp://agent/new",
          "newAgentLabel": "New agent",
          "needsInputLabel": "Needs input"
        }
        """)?.needsInput == nil,
      "a needsInputLabel without its url yields no Needs input action"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: """
        {
          "newAgentUrl": "kiloapp://agent/new",
          "newAgentLabel": "New agent",
          "needsInputUrl": "kiloapp://agent/waiting",
          "needsInputLabel": 42
        }
        """)?.needsInput == nil,
      "a non-string needsInputLabel yields no Needs input action"
    )

    let openLastSessionUrlOnly = KiloLauncherSurfacesPayload(json: """
      {
        "newAgentUrl": "kiloapp://agent/new",
        "newAgentLabel": "New agent",
        "openLastSessionUrl": "kiloapp://agent/recent"
      }
      """)
    precondition(
      openLastSessionUrlOnly?.openLastSession == nil,
      "an openLastSessionUrl without its label yields no Open last session action"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: """
        {
          "newAgentUrl": "kiloapp://agent/new",
          "newAgentLabel": "New agent",
          "openLastSessionLabel": "Open last session"
        }
        """)?.openLastSession == nil,
      "an openLastSessionLabel without its url yields no Open last session action"
    )
    precondition(
      KiloLauncherSurfacesPayload(json: """
        {
          "newAgentUrl": "kiloapp://agent/new",
          "newAgentLabel": "New agent",
          "openLastSessionUrl": "",
          "openLastSessionLabel": "Open last session"
        }
        """)?.openLastSession == nil,
      "an empty openLastSessionUrl yields no Open last session action"
    )

    let withExtras = KiloLauncherSurfacesPayload(json: """
      {
        "newAgentUrl": "kiloapp://agent/new",
        "newAgentLabel": "New agent",
        "unexpected": { "nested": [1, 2] },
        "publishedAt": 1763000000
      }
      """)
    precondition(
      withExtras?.newAgent == LauncherSurfacesAction(url: "kiloapp://agent/new", label: "New agent"),
      "unknown keys do not disturb the New agent action"
    )
    precondition(withExtras?.needsInput == nil, "unknown keys do not invent a Needs input action")
    precondition(withExtras?.openLastSession == nil, "unknown keys do not invent an Open last session action")

    print("KiloLauncherSurfacesPayload: all checks passed")
  }
}
