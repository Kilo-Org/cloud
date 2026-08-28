import UIKit

private final class ApplicationWindowCover {
  weak var window: UIWindow?
  weak var responder: UIView?
  private var previousAccessibility: Bool?
  private let opacity = UIView()

  init(_ window: UIWindow) {
    self.window = window
    opacity.backgroundColor = .systemBackground
    opacity.isOpaque = true
    opacity.isAccessibilityElement = false
    opacity.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  func apply(_ covered: Bool) {
    guard let window else { return }
    if covered {
      if previousAccessibility == nil {
        previousAccessibility = window.accessibilityElementsHidden
        responder = firstResponder(window)
        // Resign the keyboard without changing the uncontrolled composer's text or selection.
        UIView.performWithoutAnimation { window.endEditing(true) }
      }
      window.accessibilityElementsHidden = true
      opacity.frame = window.bounds
      if opacity.superview == nil { window.addSubview(opacity) }
      window.bringSubviewToFront(opacity)
    } else {
      opacity.removeFromSuperview()
      if let previousAccessibility { window.accessibilityElementsHidden = previousAccessibility }
      previousAccessibility = nil
    }
  }

  func restoreFocus() {
    guard let window, !window.isHidden, !window.accessibilityElementsHidden else { return }
    if let responder, responder.window === window, !responder.isHidden {
      responder.becomeFirstResponder()
      UIAccessibility.post(notification: .screenChanged, argument: responder)
    } else {
      var controller = window.rootViewController
      while let presented = controller?.presentedViewController { controller = presented }
      UIAccessibility.post(notification: .screenChanged, argument: controller?.view)
    }
    responder = nil
  }

  private func firstResponder(_ view: UIView) -> UIView? {
    if view.isFirstResponder { return view }
    for child in view.subviews {
      if let found = firstResponder(child) { return found }
    }
    return nil
  }
}

final class LocalAccessPrivacy: NSObject {
  static let shared = LocalAccessPrivacy()
  var emit: ((String, [String: Any]) -> Void)?
  private var state = PrivacyVisibilityState()
  private var installed = false
  private var active = false
  private var inactiveScenes = Set<ObjectIdentifier>()
  private var windows: [ObjectIdentifier: ApplicationWindowCover] = [:]
  private var scenes: [ObjectIdentifier: PrivacySceneWindow] = [:]
  private var legacyScreens: [ObjectIdentifier: PrivacySceneWindow] = [:]
  private var covers: [PrivacySceneWindow] { Array(scenes.values) + Array(legacyScreens.values) }
  private var gate: PrivacyGate?
  private var gateGeneration = -1
  private var refreshing = false

  func install() {
    precondition(Thread.isMainThread)
    guard !installed else { return }
    installed = true
    active = UIApplication.shared.applicationState == .active
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(sceneInactive), name: UIScene.willDeactivateNotification, object: nil)
    for name in [UIScene.willConnectNotification, UIScene.didActivateNotification, UIScene.didDisconnectNotification] {
      center.addObserver(self, selector: #selector(sceneChanged), name: name, object: nil)
    }
    for name in [UIWindow.didBecomeVisibleNotification, UIWindow.didBecomeHiddenNotification, UIWindow.didBecomeKeyNotification] {
      center.addObserver(self, selector: #selector(windowChanged), name: name, object: nil)
    }
    refresh()
  }

  private func isApplicationWindow(_ window: UIWindow) -> Bool {
    guard !(window is PrivacySceneWindow) else { return false }
    // Plain UIWindow includes the main window and RCTAlertController's alert+1 window.
    // UIKit's private keyboard/text-effects/remote prompt windows are not application windows.
    return type(of: window) == UIWindow.self || Bundle(for: type(of: window)) != Bundle(for: UIWindow.self)
  }

  private func sceneActive(_ scene: UIWindowScene) -> Bool {
    active && scene.activationState == .foregroundActive && !inactiveScenes.contains(ObjectIdentifier(scene))
  }

  func applicationActive(_ value: Bool) {
    precondition(Thread.isMainThread)
    let before = state.generation
    active = value
    if !value { state.setForeground(false) }
    refresh(previousGeneration: before)
  }

  @objc private func sceneInactive(_ notification: Notification) {
    guard let scene = notification.object as? UIWindowScene else { return }
    let before = state.generation
    inactiveScenes.insert(ObjectIdentifier(scene))
    state.cover()
    refresh(previousGeneration: before)
  }

  @objc private func sceneChanged(_ notification: Notification) {
    guard let scene = notification.object as? UIWindowScene else { return }
    let before = state.generation
    let id = ObjectIdentifier(scene)
    if notification.name == UIScene.didDisconnectNotification {
      scenes.removeValue(forKey: id)?.isHidden = true
      inactiveScenes.remove(id)
    } else if notification.name == UIScene.didActivateNotification {
      inactiveScenes.remove(id)
    }
    state.cover()
    refresh(additionalScene: notification.name == UIScene.didDisconnectNotification ? nil : scene,
            previousGeneration: before)
  }

  @objc private func windowChanged(_ notification: Notification) {
    guard let window = notification.object as? UIWindow, !(window is PrivacySceneWindow) else { return }
    if isApplicationWindow(window), !window.isHidden {
      register(window)
    }
    refresh()
  }

  private func register(_ window: UIWindow) {
    let id = ObjectIdentifier(window)
    if windows[id] == nil { windows[id] = ApplicationWindowCover(window) }
  }

  private func refresh(additionalScene: UIWindowScene? = nil, previousGeneration: Int? = nil) {
    precondition(Thread.isMainThread)
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    // A lifecycle handler can revoke visibility even when a companion scene keeps foreground true.
    let before = previousGeneration ?? state.generation
    var connected = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    if let additionalScene, !connected.contains(additionalScene) { connected.append(additionalScene) }
    // Compatibility: RCTAlertController and pre-scene delegates can use UIWindow(frame:).
    // Keep this public legacy enumeration until both producers require a UIWindowScene.
    UIApplication.shared.windows.filter { isApplicationWindow($0) && !$0.isHidden }.forEach(register)
    for scene in connected {
      let applicationWindows = scene.windows.filter { isApplicationWindow($0) && !$0.isHidden }
      applicationWindows.forEach(register)
      let id = ObjectIdentifier(scene)
      if state.armed, !applicationWindows.isEmpty, scenes[id] == nil {
        scenes[id] = PrivacySceneWindow(windowScene: scene)
      }
    }
    let legacyWindows = windows.values.compactMap(\.window).filter { $0.windowScene == nil && !$0.isHidden }
    let legacyFocused = !legacyWindows.isEmpty &&
      (legacyWindows.contains { $0.isKeyWindow } || legacyScreens.values.contains { $0.isKeyWindow })
    let sceneFocused = connected.contains { scene in
      sceneActive(scene) && scene.windows.contains { $0.isKeyWindow && (isApplicationWindow($0) || $0 is PrivacySceneWindow) }
    }
    state.setForeground(sceneFocused || (active && legacyFocused))
    // Save focus and suppress content before the gate can become key or post accessibility focus.
    for (id, entry) in windows {
      guard let window = entry.window, !window.isHidden else {
        entry.apply(false)
        windows.removeValue(forKey: id)
        continue
      }
      let sceneCovered = window.windowScene.map { !sceneActive($0) } ?? !active
      entry.apply(state.armed && (state.covered || sceneCovered))
    }
    for scene in connected {
      let applicationWindows = scene.windows.filter { isApplicationWindow($0) && !$0.isHidden }
      let covered = state.armed && (state.covered || !sceneActive(scene))
      let topLevel = applicationWindows.map(\.windowLevel.rawValue).max() ?? UIWindow.Level.normal.rawValue
      scenes[ObjectIdentifier(scene)]?.update(
        covered: covered,
        interactive: state.foreground && sceneActive(scene) && gateGeneration == state.generation,
        level: topLevel + 1,
        gate: gate,
        generation: state.generation,
        onAction: { [weak self] generation, id in self?.gateAction(generation, id: id) }
      )
    }
    updateLegacyWindows(legacyWindows)
    if before != state.generation { notify() }
  }

  private func updateLegacyWindows(_ applicationWindows: [UIWindow]) {
    let groups = Dictionary(grouping: applicationWindows) { ObjectIdentifier($0.screen) }
    for (id, group) in groups {
      guard let window = group.first else { continue }
      if state.armed, legacyScreens[id] == nil {
        let cover = PrivacySceneWindow(frame: window.screen.bounds)
        cover.screen = window.screen
        legacyScreens[id] = cover
      }
      let topLevel = group.map(\.windowLevel.rawValue).max() ?? UIWindow.Level.normal.rawValue
      legacyScreens[id]?.update(
        covered: state.covered,
        interactive: state.foreground && gateGeneration == state.generation,
        level: topLevel + 1,
        gate: gate,
        generation: state.generation,
        keyCandidate: group.first { $0.isKeyWindow },
        onAction: { [weak self] generation, id in self?.gateAction(generation, id: id) }
      )
    }
    for (id, cover) in legacyScreens where !state.armed || groups[id] == nil {
      cover.isHidden = true
      legacyScreens.removeValue(forKey: id)
    }
  }

  func arm() {
    install()
    state.arm()
    refresh()
    notify()
  }

  func disarm() {
    state.disarm()
    gate = nil
    refresh()
    covers.forEach { $0.isHidden = true }
    scenes.removeAll()
    notify()
  }

  func cover() {
    state.cover()
    refresh()
    notify()
  }

  func publish(_ generation: Int) -> Bool {
    refresh()
    let wasCovered = state.covered
    guard state.publish(generation) else { return false }
    if wasCovered {
      refresh()
      // Duplicate publication must not move focus or emit another visibility event.
      windows.values.first {
        $0.window?.isKeyWindow == true && $0.window?.accessibilityElementsHidden == false
      }?.restoreFocus()
      notify()
    }
    return true
  }

  func snapshot() -> [String: Any] {
    refresh()
    return ["generation": state.generation, "armed": state.armed, "foreground": state.foreground,
            "covered": state.covered, "failed": state.failed]
  }

  func foregroundAllowed() -> Bool {
    refresh()
    return state.admitsForeground
  }

  func admitsAnnouncement(_ generation: Int, gate: Bool) -> Bool {
    refresh()
    return state.admitsAnnouncement(generation, gate: gate)
  }

  func setGate(_ generation: Int, gate: PrivacyGate?) -> Bool {
    refresh()
    guard state.armed, generation == state.generation else { return false }
    self.gate = gate
    gateGeneration = generation
    covers.forEach { $0.resetGate() }
    refresh()
    return true
  }

  private func gateAction(_ generation: Int, id: String) {
    refresh()
    guard state.covered, state.foreground, generation == state.generation,
      gate?.actions.contains(where: { $0.id == id && $0.enabled }) == true else { return }
    emit?("onGateAction", ["generation": generation, "id": id])
  }

  private func notify() {
    emit?("onVisibilityChange", ["generation": state.generation, "armed": state.armed,
                               "foreground": state.foreground, "covered": state.covered, "failed": state.failed])
  }
}
