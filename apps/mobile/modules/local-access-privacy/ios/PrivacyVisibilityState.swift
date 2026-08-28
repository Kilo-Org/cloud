// Native activity and visibility only. Authentication and background timing stay in TypeScript.
struct PrivacyVisibilityState {
  private(set) var armed = false
  private(set) var foreground = false
  private(set) var visible = false
  private(set) var failed = false
  private(set) var generation = 0

  var covered: Bool { armed && (!foreground || !visible || failed) }
  var admitsForeground: Bool { foreground && (!armed || (!covered && !failed)) }

  mutating func arm() {
    armed = true
    failed = false
    cover()
  }

  mutating func disarm() {
    armed = false
    failed = false
    cover()
  }

  mutating func cover() {
    visible = false
    generation += 1
  }

  mutating func setForeground(_ value: Bool) {
    guard foreground != value else { return }
    foreground = value
    cover()
  }

  mutating func fail() {
    failed = true
    cover()
  }

  mutating func publish(_ expectedGeneration: Int) -> Bool {
    guard armed, foreground, !failed, expectedGeneration == generation else { return false }
    visible = true
    return true
  }

  func admitsAnnouncement(_ expectedGeneration: Int, gate: Bool) -> Bool {
    expectedGeneration == generation && (!armed || (foreground && (gate || (!failed && visible))))
  }
}
