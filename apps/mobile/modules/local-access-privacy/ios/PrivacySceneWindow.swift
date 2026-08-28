import UIKit

// Scene-owned covers stay above application presentations, not above arbitrary OS windows.
// The frame initializer preserves RCTAlertController's supported scene-less fallback.
final class PrivacySceneWindow: UIWindow {
  private var acceptsKey = false
  private weak var previousKey: UIWindow?
  private var renderedGeneration = -1
  private var gateView: UIView?
  override var canBecomeKey: Bool { acceptsKey }

  override init(windowScene: UIWindowScene) {
    super.init(windowScene: windowScene)
    configure()
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    configure()
  }

  private func configure() {
    let controller = UIViewController()
    controller.view.backgroundColor = .systemBackground
    controller.view.isOpaque = true
    rootViewController = controller
    accessibilityElementsHidden = true
  }

  required init?(coder: NSCoder) { return nil }

  func resetGate() { renderedGeneration = -1 }

  func update(
    covered: Bool, interactive: Bool, level: CGFloat, gate: PrivacyGate?, generation: Int,
    keyCandidate: UIWindow? = nil, onAction: @escaping (Int, String) -> Void
  ) {
    if let windowScene { frame = windowScene.coordinateSpace.bounds }
    windowLevel = UIWindow.Level(rawValue: level)
    let showGate = covered && interactive && gate != nil
    acceptsKey = showGate
    isUserInteractionEnabled = covered && interactive
    accessibilityElementsHidden = !showGate
    rootViewController?.view.accessibilityViewIsModal = showGate
    if !showGate, isKeyWindow {
      resignKey()
      if let previousKey, !previousKey.isHidden { previousKey.makeKey() }
    }
    isHidden = !covered
    gateView?.isHidden = !showGate
    guard showGate, let gate, let root = rootViewController?.view else { return }
    if renderedGeneration != generation {
      gateView?.removeFromSuperview()
      let scroll = UIScrollView()
      scroll.translatesAutoresizingMaskIntoConstraints = false
      root.addSubview(scroll)
      NSLayoutConstraint.activate([
        scroll.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor, constant: 24),
        scroll.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor, constant: -24),
        scroll.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor, constant: 24),
        scroll.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor, constant: -24)
      ])
      let stack = UIStackView()
      stack.axis = .vertical
      stack.spacing = 16
      stack.translatesAutoresizingMaskIntoConstraints = false
      scroll.addSubview(stack)
      NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
        stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
        stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
        stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
        stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
      ])
      for (text, style) in [(gate.title, UIFont.TextStyle.title1), (gate.message, .body)] {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        stack.addArrangedSubview(label)
      }
      for action in gate.actions {
        let button = UIButton(type: .system)
        button.setTitle(action.label, for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.titleLabel?.numberOfLines = 0
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.isEnabled = action.enabled
        button.addAction(UIAction { _ in onAction(generation, action.id) }, for: .touchUpInside)
        stack.addArrangedSubview(button)
      }
      gateView = scroll
      renderedGeneration = generation
      UIAccessibility.post(notification: .screenChanged, argument: stack.arrangedSubviews.first)
    }
    if !isKeyWindow {
      // Do not replace a system-owned key window, including authentication controls.
      if let key = windowScene?.windows.first(where: { $0.isKeyWindow }) ?? keyCandidate,
        type(of: key) == UIWindow.self || Bundle(for: type(of: key)) != Bundle(for: UIWindow.self) {
        previousKey = key
        makeKey()
      }
    }
  }
}
