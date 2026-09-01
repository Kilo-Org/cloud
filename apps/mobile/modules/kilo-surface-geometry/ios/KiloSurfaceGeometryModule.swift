import ExpoModulesCore
import UIKit

public final class KiloSurfaceGeometryModule: Module {
  private var probes: [Int: WeakSurfaceGeometryProbe] = [:]
  private let lifecycleLock = NSLock()
  private var generation = 0
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("KiloSurfaceGeometry")
    Constant("isSupported") { true }
    Events("onSurfaceGeometryChange")

    AsyncFunction("observeSurface") { (tag: Int) -> [String: Any] in
      guard let generation = self.currentGeneration(),
            let root = self.appContext?.findView(withTag: tag, ofType: UIView.self) else {
        throw SurfaceViewNotFoundException()
      }
      let probe: SurfaceGeometryProbe
      if let existing = self.probes[tag]?.probe, existing.generation == generation, existing.observes(root) {
        probe = existing
      } else {
        self.probes.removeValue(forKey: tag)?.probe?.stop()
        probe = SurfaceGeometryProbe(root: root, tag: tag, generation: generation) { [weak self] geometry in
          guard let self, self.currentGeneration() == generation else { return }
          self.sendEvent("onSurfaceGeometryChange", geometry)
        } onStop: { [weak self] probe in
          if self?.probes[tag]?.probe === probe {
            self?.probes.removeValue(forKey: tag)
          }
        }
        self.probes[tag] = WeakSurfaceGeometryProbe(probe)
        probe.start()
      }
      let geometry = probe.snapshot()
      guard self.currentGeneration() == generation else {
        probe.stop()
        throw SurfaceViewNotFoundException()
      }
      return geometry
    }.runOnQueue(.main)

    AsyncFunction("unobserveSurface") { (tag: Int) in
      self.probes.removeValue(forKey: tag)?.probe?.stop()
    }.runOnQueue(.main)

    OnStopObserving {
      self.stopObserving()
    }
    OnDestroy {
      self.stopObserving(destroying: true)
    }
  }

  private func currentGeneration() -> Int? {
    lifecycleLock.withLock { destroyed ? nil : generation }
  }

  private func stopObserving(destroying: Bool = false) {
    let retiredGeneration = lifecycleLock.withLock {
      let retired = generation
      generation += 1
      destroyed = destroyed || destroying
      return retired
    }
    let cleanup = {
      let retired = self.probes.values.compactMap { $0.probe }.filter { $0.generation <= retiredGeneration }
      retired.forEach { $0.stop() }
      self.probes = self.probes.filter { $0.value.probe != nil }
    }
    if Thread.isMainThread {
      cleanup()
    } else {
      DispatchQueue.main.async(execute: cleanup)
    }
  }
}

private final class SurfaceViewNotFoundException: Exception {
  override var reason: String { "The native surface view is not mounted." }
}

private final class WeakSurfaceGeometryProbe {
  weak var probe: SurfaceGeometryProbe?

  init(_ probe: SurfaceGeometryProbe) {
    self.probe = probe
  }
}

private final class SurfaceGeometryProbe: UIView {
  let generation: Int
  private weak var root: UIView?
  private let tag: Int
  private let emit: ([String: Any]) -> Void
  private let onStop: (SurfaceGeometryProbe) -> Void
  private let keyboardEdge = UIView()
  private var observations: [NSKeyValueObservation] = []
  private var ancestorIDs: [ObjectIdentifier] = []
  private var notifications: [NSObjectProtocol] = []
  private var previous: [String: Double]?
  private var scheduled = false
  private var observingWindow = false
  private var attachmentGeneration = 0
  private var stopped = false

  init(root: UIView, tag: Int, generation: Int, emit: @escaping ([String: Any]) -> Void,
       onStop: @escaping (SurfaceGeometryProbe) -> Void) {
    self.root = root
    self.tag = tag
    self.generation = generation
    self.emit = emit
    self.onStop = onStop
    super.init(frame: root.bounds)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    backgroundColor = .clear
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
    keyboardLayoutGuide.followsUndockedKeyboard = false
    if #available(iOS 17.0, *) {
      keyboardLayoutGuide.usesBottomSafeArea = false
    }
    keyboardEdge.translatesAutoresizingMaskIntoConstraints = false
    addSubview(keyboardEdge)
    NSLayoutConstraint.activate([
      keyboardEdge.leadingAnchor.constraint(equalTo: leadingAnchor),
      keyboardEdge.topAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
      keyboardEdge.widthAnchor.constraint(equalToConstant: 0),
      keyboardEdge.heightAnchor.constraint(equalToConstant: 0)
    ])
  }

  required init?(coder: NSCoder) {
    return nil
  }

  deinit {
    observations.forEach { $0.invalidate() }
    notifications.forEach { NotificationCenter.default.removeObserver($0) }
  }

  func start() {
    guard !stopped, let root else {
      stop()
      return
    }
    root.addSubview(self)
    updateAttachment()
  }

  private func updateAttachment() {
    guard !stopped, let root, superview === root else {
      stop()
      return
    }
    guard window != nil else {
      pause()
      _ = snapshot()
      return
    }
    if !observingWindow {
      observingWindow = true
      for name in [UIResponder.keyboardDidChangeFrameNotification, UIResponder.keyboardDidHideNotification,
                   UIApplication.didBecomeActiveNotification] {
        notifications.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
          [weak self] _ in self?.schedule()
        })
      }
    }
    observeAncestors()
    layoutIfNeeded()
    schedule()
  }

  private func pause() {
    observingWindow = false
    attachmentGeneration += 1
    scheduled = false
    observations.forEach { $0.invalidate() }
    observations.removeAll()
    ancestorIDs.removeAll()
    notifications.forEach { NotificationCenter.default.removeObserver($0) }
    notifications.removeAll()
  }

  func observes(_ view: UIView) -> Bool {
    !stopped && root === view && superview === view
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    schedule()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    schedule()
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    if superview == nil || superview !== root {
      stop()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateAttachment()
  }

  private func schedule() {
    guard !stopped, observingWindow, window != nil, !scheduled else { return }
    scheduled = true
    let generation = attachmentGeneration
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped, self.observingWindow,
            self.attachmentGeneration == generation else { return }
      self.scheduled = false
      _ = self.snapshot()
    }
  }

  private func observeAncestors() {
    var ancestors: [UIView] = []
    var ancestor = root
    while let view = ancestor {
      ancestors.append(view)
      ancestor = view.superview
    }
    let ids = ancestors.map { ObjectIdentifier($0) }
    guard ids != ancestorIDs else { return }
    observations.forEach { $0.invalidate() }
    observations.removeAll()
    ancestorIDs = ids
    for view in ancestors {
      let layer = view.layer
      observations.append(layer.observe(\.bounds) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.position) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.transform) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.sublayerTransform) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.masksToBounds) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.isHidden) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.opacity) { [weak self] _, _ in self?.schedule() })
      observations.append(layer.observe(\.superlayer) { [weak self] _, _ in self?.schedule() })
    }
  }

  func snapshot() -> [String: Any] {
    guard !stopped, let root, superview === root else {
      stop()
      return ["tag": tag, "visibleTop": 0.0, "visibleBottom": 0.0, "boundsHeight": 0.0,
              "safeAreaTop": 0.0, "safeAreaBottom": 0.0, "keyboardOverlap": 0.0]
    }
    if observingWindow {
      observeAncestors()
      if frame != root.bounds {
        frame = root.bounds
        layoutIfNeeded()
      }
    }
    let geometry = measure(root)
    var event: [String: Any] = geometry
    event["tag"] = tag
    if previous != geometry {
      previous = geometry
      emit(event)
    }
    return event
  }

  private func measure(_ root: UIView) -> [String: Double] {
    let height = max(0, root.bounds.height)
    let safeTop = min(height, max(0, root.safeAreaInsets.top))
    let safeBottom = min(height, max(0, root.safeAreaInsets.bottom))
    let empty = ["visibleTop": 0.0, "visibleBottom": 0.0, "boundsHeight": Double(height),
                 "safeAreaTop": Double(safeTop), "safeAreaBottom": Double(safeBottom),
                 "keyboardOverlap": 0.0]
    guard observingWindow, let window = root.window, height > 0 else { return empty }
    var visible = root.bounds.intersection(root.convert(window.bounds, from: window))
    var ancestor: UIView? = root
    var alpha: CGFloat = 1
    while let view = ancestor {
      alpha *= view.alpha
      if view.isHidden || alpha <= 0.01 { return empty }
      if view.clipsToBounds {
        visible = visible.intersection(root.convert(view.bounds, from: view))
      }
      ancestor = view.superview
    }
    guard !visible.isNull, !visible.isEmpty else { return empty }
    let keyboard = root.convert(keyboardLayoutGuide.layoutFrame, from: self)
    let idleKeyboardHeight: CGFloat
    if #available(iOS 17.0, *) {
      idleKeyboardHeight = 0
    } else {
      idleKeyboardHeight = safeAreaInsets.bottom
    }
    let top = max(0, visible.minY - root.bounds.minY)
    let bottom = min(height, visible.maxY - root.bounds.minY)
    var visibleBottom = bottom
    if keyboard.height > idleKeyboardHeight, keyboard.intersects(visible), keyboard.maxY >= visible.maxY {
      visibleBottom = max(top, min(bottom, keyboard.minY - root.bounds.minY))
    }
    return [
      "visibleTop": Double(top),
      "visibleBottom": Double(visibleBottom),
      "boundsHeight": Double(height),
      "safeAreaTop": Double(safeTop),
      "safeAreaBottom": Double(safeBottom),
      "keyboardOverlap": Double(bottom - visibleBottom)
    ]
  }

  func stop() {
    guard !stopped else { return }
    stopped = true
    pause()
    removeFromSuperview()
    root = nil
    onStop(self)
  }
}
