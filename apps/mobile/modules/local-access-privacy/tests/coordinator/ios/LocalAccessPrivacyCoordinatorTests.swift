import UIKit

// Record rendering requests only. PrivacySceneWindow's real UIKit rendering needs device verification.
struct PrivacyGateAction { let id: String; let enabled: Bool }
struct PrivacyGate { let actions: [PrivacyGateAction] }
final class PrivacySceneWindow: UIWindow {
  var gateVisible = false
  func resetGate() {}
  func update(
    covered: Bool, interactive: Bool, level: CGFloat, gate: PrivacyGate?, generation: Int,
    keyCandidate: UIWindow? = nil, onAction: @escaping (Int, String) -> Void
  ) {
    isHidden = !covered
    gateVisible = covered && interactive && gate != nil
  }
}

private enum Transition: String, CaseIterable {
  case activation, deactivation, connection, disconnection, applicationInactivity
}

private final class Fixture {
  let coordinator = LocalAccessPrivacy()
  let scene = UIWindowScene()
  let companion = UIWindowScene()
  let window: UIWindow
  let companionWindow: UIWindow
  var events: [[String: Any]] = []
  var coveredAtEmission: [Bool] = []
  var generation: Int { coordinator.snapshot()["generation"] as! Int }
  var companionGate: PrivacySceneWindow? { companion.windows.compactMap { $0 as? PrivacySceneWindow }.first }

  init(_ transition: Transition) {
    window = UIWindow(windowScene: scene)
    companionWindow = UIWindow(windowScene: companion)
    window.isHidden = false
    companionWindow.isHidden = false
    window.isKeyWindow = true
    companionWindow.isKeyWindow = true
    if transition == .activation || transition == .connection { scene.activationState = .foregroundInactive }
    let application = UIApplication.shared
    application.applicationState = .active
    application.connectedScenes = transition == .connection ? [companion] : [scene, companion]
    application.windows = transition == .connection ? [companionWindow] : [window, companionWindow]
    coordinator.arm()
    precondition(coordinator.publish(generation), "Fixture must publish current access")
    coordinator.emit = { [weak self] name, snapshot in
      guard let self, name == "onVisibilityChange" else { return }
      events.append(snapshot)
      coveredAtEmission.append(companionWindow.accessibilityElementsHidden)
    }
  }

  func deliver(_ transition: Transition) {
    let center = NotificationCenter.default
    switch transition {
    case .activation:
      scene.activationState = .foregroundActive
      center.post(name: UIScene.didActivateNotification, object: scene)
    case .deactivation:
      // UIKit still reports foregroundActive during willDeactivate. The coordinator must revoke now.
      center.post(name: UIScene.willDeactivateNotification, object: scene)
    case .connection:
      center.post(name: UIScene.willConnectNotification, object: scene)
    case .disconnection:
      UIApplication.shared.connectedScenes.remove(scene)
      window.isHidden = true
      center.post(name: UIScene.didDisconnectNotification, object: scene)
    case .applicationInactivity:
      // The companion scene still reports active when the application callback arrives.
      coordinator.applicationActive(false)
    }
  }

  func dispose() {
    coordinator.emit = nil
    NotificationCenter.default.removeObserver(coordinator)
    coordinator.disarm()
    UIApplication.shared.connectedScenes = []
    UIApplication.shared.windows = []
  }
}

@main
struct LocalAccessPrivacyCoordinatorTests {
  static func main() {
    var failures: [String] = []
    var checks = 0
    func expect(_ value: Bool, _ message: String) {
      checks += 1
      if !value { failures.append(message) }
    }
    for transition in Transition.allCases {
      let fixture = Fixture(transition)
      let coordinator = fixture.coordinator
      let previous = fixture.generation
      let gate = PrivacyGate(actions: [PrivacyGateAction(id: "retry", enabled: true)])
      expect(coordinator.setGate(previous, gate: gate), "\(transition): initial gate must be accepted")
      fixture.deliver(transition)
      // Check delivery before any snapshot read can refresh or notify the shell.
      expect(fixture.events.count == 1, "\(transition): shell must receive exactly one visibility event")
      expect(fixture.coveredAtEmission == [true], "\(transition): native coverage must precede shell notification")
      expect(fixture.companionWindow.accessibilityElementsHidden, "\(transition): cover the companion before returning from the callback")
      let snapshot = coordinator.snapshot()
      let current = fixture.generation
      let active = transition != .applicationInactivity
      expect(current > previous, "\(transition): lifecycle transition must revoke the old generation")
      expect(snapshot["foreground"] as? Bool == active, "\(transition): aggregate activity must match the native scene inputs")
      expect(fixture.events.first?["generation"] as? Int == current, "\(transition): shell must receive the latest generation")
      expect(fixture.companionGate?.gateVisible == false, "\(transition): the old gate must not remain interactive")
      expect(!coordinator.foregroundAllowed(), "\(transition): revoked visibility must deny admission")
      expect(!coordinator.publish(previous), "\(transition): stale publication must fail")
      expect(!coordinator.setGate(previous, gate: gate), "\(transition): a stale gate must fail")
      expect(fixture.events.count == 1, "\(transition): reads and rejected handshakes must not duplicate the notification")
      if active {
        expect(coordinator.setGate(current, gate: gate), "\(transition): the notified generation must accept a fresh gate")
        expect(fixture.companionGate?.gateVisible == true, "\(transition): the companion must regain its current gate")
        expect(coordinator.publish(current), "\(transition): the notified generation must permit a fresh handshake")
        expect(!fixture.companionWindow.accessibilityElementsHidden, "\(transition): a fresh handshake must restore companion content")
      } else {
        expect(!coordinator.publish(current), "Application inactivity must reject even a current publication")
        expect(coordinator.setGate(current, gate: gate), "The shell can prepare a current gate while inactive")
        expect(fixture.companionGate?.gateVisible == false, "An inactive gate must remain passive for the native prompt")
        coordinator.applicationActive(true)
        let returned = fixture.generation
        expect(fixture.events.count == 2, "Application return must deliver one new generation")
        expect(fixture.events.last?["generation"] as? Int == returned, "Application return must notify the current generation")
        expect(!coordinator.publish(current), "The inactive generation must not authorize foreground return")
        expect(fixture.companionWindow.accessibilityElementsHidden, "Foreground return alone must keep content covered")
        expect(coordinator.publish(returned), "Foreground return requires a fresh handshake")
      }
      fixture.dispose()
    }
    print("LocalAccessPrivacy iOS coordinator: \(checks - failures.count)/\(checks) checks passed across 5 transitions")
    failures.forEach { print("FAIL: \($0)") }
    if !failures.isEmpty { exit(1) }
  }
}
