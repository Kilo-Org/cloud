@main
struct PrivacyVisibilityStateTests {
  static func main() {
    var checks = 0
    func check(_ value: Bool, _ message: String) {
      precondition(value, message)
      checks += 1
    }
    var state = PrivacyVisibilityState()
    check(!state.covered, "Disarmed content must retain its old visibility")
    check(state.admitsAnnouncement(state.generation, gate: false), "Disarmed announcements must work")
    check(!state.admitsForeground, "A missing native foreground must deny effects")
    state.setForeground(true)
    state.arm()
    check(state.covered, "Arming must cover before authenticated content mounts")
    check(!state.admitsForeground, "Foreground alone must not authorize armed effects")
    check(!state.admitsAnnouncement(state.generation, gate: false), "Protected speech must stay hidden")
    check(state.admitsAnnouncement(state.generation, gate: true), "Non-sensitive gate speech must remain usable")
    let first = state.generation
    check(state.publish(first), "Current access publication must reveal content")
    check(!state.covered && state.admitsForeground, "Published content must admit effects")
    check(state.admitsAnnouncement(first, gate: false), "Allowed content must permit speech")
    state.setForeground(true)
    check(state.generation == first && !state.covered, "An app dialog retaining foreground must not revoke visibility")
    state.setForeground(false)
    check(state.covered && !state.admitsForeground, "Inactivity must cover synchronously")
    check(!state.admitsAnnouncement(first, gate: false), "Queued speech must fail after inactivity")
    check(!state.admitsAnnouncement(state.generation, gate: true), "A passive cover must not announce a gate over a prompt")
    check(!state.publish(state.generation), "Inactive publication must not expose content")
    state.setForeground(true)
    check(state.covered, "Native foreground must never uncover on its own")
    check(!state.publish(first), "A stale visibility generation must never uncover")
    check(state.publish(state.generation), "A fresh readiness handshake must restore visibility")
    check(!state.admitsAnnouncement(first, gate: false), "Unlock must never replay stale speech")
    let beforeOwnerChange = state.generation
    state.cover()
    check(!state.publish(beforeOwnerChange), "Owner revocation must invalidate old visibility")
    state.fail()
    check(state.covered && !state.publish(state.generation), "Native failure must remain protected")
    check(!state.admitsForeground, "Native failure must deny effects")
    check(state.admitsAnnouncement(state.generation, gate: true), "Recovery speech must remain non-sensitive")
    let beforeDisarm = state.generation
    state.disarm()
    check(!state.covered && state.admitsForeground, "Unmounted content must release protection")
    check(!state.admitsAnnouncement(beforeDisarm, gate: false), "Disarm must not deliver old account speech")
    check(state.admitsAnnouncement(state.generation, gate: false), "Fresh disarmed speech must work")
    check(!state.publish(state.generation), "Publication cannot arm an empty shell")
    print("PrivacyVisibilityState Swift: \(checks) checks passed")
  }
}
