// Compiles and runs with the builder alone:
// swiftc -parse-as-library ios/HomeWidgetAccessibilityLabel.swift tests/HomeWidgetAccessibilityLabelTests.swift
@main struct HomeWidgetAccessibilityLabelTests {
  static func main() {
    let expired = homeWidgetAccessibilityLabel([
      "statusLine": "Status expired",
      "countLines": [],
      "openAgents": "Open agents",
      "digits": "",
      "group": ",",
      "listJoiner": ", ",
    ])
    precondition(expired.contains("Status expired"))
    precondition(expired.contains("Open agents"))
    for absent in ["Working", "Idle", "Scheduled", "0"] {
      precondition(!expired.contains(absent))
    }

    let signedOut = homeWidgetAccessibilityLabel([
      "statusLine": "Open Kilo to see agents",
      "countLines": [],
      "digits": "",
      "group": ",",
      "listJoiner": ", ",
    ])
    precondition(signedOut == "Open Kilo to see agents")

    let japanese = homeWidgetAccessibilityLabel([
      "countLines": [
        ["count": 3, "label": "作業中"],
        ["count": 2, "label": "入力が必要"],
        ["count": 1, "label": "待機中"],
      ],
      "openAgents": "エージェントを開く",
      "digits": "",
      "group": ",",
      "listJoiner": "、",
    ])
    precondition(japanese.contains("3 作業中、2 入力が必要、1 待機中"))
    precondition(!japanese.contains(", "))

    let arabic = homeWidgetAccessibilityLabel([
      "countLines": [["count": 1234, "label": "بانتظار تدخلك"]],
      "openAgents": "فتح الوكلاء",
      "digits": "٠١٢٣٤٥٦٧٨٩",
      "group": "٬",
      "listJoiner": "، ",
    ])
    precondition(arabic.contains("١٬٢٣٤ بانتظار تدخلك"))
    precondition(!arabic.contains("1234"))
    precondition(!arabic.contains(", "))

    let zeroed = homeWidgetAccessibilityLabel([
      "countLines": [
        ["count": 0, "label": "待機中"],
        ["count": 2, "label": "作業中"],
      ],
      "digits": "",
      "group": ",",
      "listJoiner": ", ",
    ])
    precondition(zeroed == "2 作業中")

    // No joiner in the input must not fall back to a literal comma-space.
    let noJoiner = homeWidgetAccessibilityLabel([
      "countLines": [
        ["count": 1, "label": "Working"],
        ["count": 2, "label": "Needs input"],
      ],
      "digits": "",
      "group": ",",
    ])
    precondition(!noJoiner.contains(", "))

    print("HomeWidgetAccessibilityLabel: all checks passed")
  }
}
