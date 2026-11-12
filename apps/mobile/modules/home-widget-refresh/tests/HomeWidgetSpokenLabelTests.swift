import Foundation

/// Checks the extension's entry assembly against the cases the app-side test
/// writes, so both implementations answer with the same sentence.
///
/// `spoken-label.test.ts` builds each case from the real catalogs, the app's own
/// count formatter, and the shared presentation policy, writes them as JSON, and
/// runs this binary on macOS. A Foundation-only source compiles without
/// WidgetKit or Security, which is why the rule lives beside the store rather
/// than inside it.
@main
struct HomeWidgetSpokenLabelTests {
  static func main() throws {
    guard CommandLine.arguments.count > 1 else {
      print("usage: spoken-label <cases.json>")
      exit(2)
    }
    let path = CommandLine.arguments[1]
    guard
      let root = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
        as? [String: Any],
      let cases = root["cases"] as? [[String: Any]],
      let terminal = root["terminal"] as? [[String: Any]],
      let entries = root["entries"] as? [[String: Any]]
    else {
      print("cases file is not the expected shape: \(path)")
      exit(2)
    }
    var checked = 0
    for entry in cases {
      let name = entry["name"] as? String ?? "?"
      let copy = entry["copy"] as? [String: String] ?? [:]
      let statusLine = entry["statusLine"] as? String
      let countLines = entry["countLines"] as? [[String: Any]] ?? []
      guard let expected = entry["expected"] as? String else {
        print("case \(name) has no expected text")
        exit(1)
      }
      let actual = HomeWidgetSpokenLabel.text(
        statusLine: statusLine,
        countLines: countLines,
        copy: copy
      )
      guard actual == expected else {
        print("case \(name)\n  expected: \(expected)\n  actual:   \(actual)")
        exit(1)
      }
      checked += 1
    }
    for entry in terminal {
      let name = entry["name"] as? String ?? "?"
      let copy = entry["copy"] as? [String: String] ?? [:]
      guard let expected = entry["expected"] as? String else {
        print("terminal case \(name) has no expected text")
        exit(1)
      }
      let actual = HomeWidgetSpokenLabel.signedOutStatus(copy)
      guard actual == expected else {
        print("terminal case \(name)\n  expected: \(expected)\n  actual:   \(actual)")
        exit(1)
      }
      checked += 1
    }
    for entry in entries {
      let name = entry["name"] as? String ?? "?"
      let copy = entry["copy"] as? [String: String] ?? [:]
      let props = HomeWidgetEntryProps.refreshed(
        base: [:],
        presentation: entry["presentation"] as? [String: Any] ?? [:],
        snapshot: entry["snapshot"] as? [String: Any] ?? [:],
        copy: copy,
        at: entry["at"] as? Double ?? 0,
        expires: entry["expires"] as? Double
      )
      guard
        let expectedLabel = entry["expectedLabel"] as? String,
        let expectedLines = entry["expectedCountLines"] as? [String]
      else {
        print("entry case \(name) is missing its expectation")
        exit(1)
      }
      let lines = (props["countLines"] as? [[String: Any]] ?? [])
        .compactMap { line -> String? in
          guard let count = line["count"] as? Int, let label = line["label"] as? String else {
            return nil
          }
          return "\(count) \(label)"
        }
      let label = props["accessibilityLabel"] as? String ?? ""
      let status = props["statusLine"] as? String
      let expectedStatus = entry["expectedStatusLine"] as? String
      guard lines == expectedLines else {
        print("entry \(name) count lines\n  expected: \(expectedLines)\n  actual:   \(lines)")
        exit(1)
      }
      guard status == expectedStatus else {
        print(
          "entry \(name) status line\n  expected: \(String(describing: expectedStatus))\n  actual:   \(String(describing: status))"
        )
        exit(1)
      }
      guard label == expectedLabel else {
        print("entry \(name) label\n  expected: \(expectedLabel)\n  actual:   \(label)")
        exit(1)
      }
      checked += 1
    }
    let terminalEntry = HomeWidgetEntryProps.terminal(copy: [:])
    guard
      let status = terminalEntry["statusLine"] as? String,
      !status.isEmpty,
      terminalEntry["accessibilityLabel"] as? String == status
    else {
      print("the terminal entry is blank or unlabeled with no copy at all")
      exit(1)
    }
    checked += 1
    guard checked > 0 else {
      print("no cases ran")
      exit(1)
    }
    print("all checks passed")
  }
}