// Test-only UIKit inputs for executing the real coordinator on the host. No rendering or OS timing is modeled.
@_exported import Foundation
@_exported import CoreGraphics

public struct UIColor { public static let systemBackground = UIColor() }

open class UIView: NSObject {
  public struct AutoresizingMask: OptionSet {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let flexibleWidth = AutoresizingMask(rawValue: 1)
    public static let flexibleHeight = AutoresizingMask(rawValue: 2)
  }
  public var frame: CGRect
  public var bounds: CGRect { frame }
  public var backgroundColor: UIColor?
  public var isOpaque = false
  public var isAccessibilityElement = false
  public var accessibilityElementsHidden = false
  public var isHidden = false
  public var isFirstResponder = false
  public var autoresizingMask: AutoresizingMask = []
  public weak var superview: UIView?
  public private(set) var subviews: [UIView] = []
  public var window: UIWindow? { (self as? UIWindow) ?? superview?.window }
  public init(frame: CGRect = .zero) { self.frame = frame; super.init() }
  public static func performWithoutAnimation(_ body: () -> Void) { body() }
  public func addSubview(_ view: UIView) { view.removeFromSuperview(); subviews.append(view); view.superview = self }
  public func removeFromSuperview() { superview?.subviews.removeAll { $0 === self }; superview = nil }
  public func bringSubviewToFront(_ view: UIView) { subviews.removeAll { $0 === view }; subviews.append(view) }
  @discardableResult public func endEditing(_ force: Bool) -> Bool {
    isFirstResponder = false
    subviews.forEach { $0.endEditing(force) }
    return true
  }
  @discardableResult public func becomeFirstResponder() -> Bool { isFirstResponder = true; return true }
}

public final class UIViewController: NSObject {
  public var presentedViewController: UIViewController?
  public let view = UIView()
}

public class UIScene: NSObject {
  public enum ActivationState { case foregroundActive, foregroundInactive, background }
  public var activationState = ActivationState.foregroundActive
  public static let willDeactivateNotification = Notification.Name("sceneWillDeactivate")
  public static let willConnectNotification = Notification.Name("sceneWillConnect")
  public static let didActivateNotification = Notification.Name("sceneDidActivate")
  public static let didDisconnectNotification = Notification.Name("sceneDidDisconnect")
}

public final class UIWindowScene: UIScene { public var windows: [UIWindow] = [] }
public final class UIScreen: NSObject {
  public static let main = UIScreen()
  public let bounds = CGRect(x: 0, y: 0, width: 400, height: 800)
}

open class UIWindow: UIView {
  public struct Level {
    public let rawValue: CGFloat
    public init(rawValue: CGFloat) { self.rawValue = rawValue }
    public static let normal = Level(rawValue: 0)
  }
  public static let didBecomeVisibleNotification = Notification.Name("windowVisible")
  public static let didBecomeHiddenNotification = Notification.Name("windowHidden")
  public static let didBecomeKeyNotification = Notification.Name("windowKey")
  public var isKeyWindow = false
  public var windowLevel = Level.normal
  public var rootViewController: UIViewController?
  public var screen = UIScreen.main
  public weak var windowScene: UIWindowScene?
  public override init(frame: CGRect) { super.init(frame: frame); isHidden = true }
  public init(windowScene: UIWindowScene) {
    self.windowScene = windowScene
    super.init()
    isHidden = true
    windowScene.windows.append(self)
  }
}

public final class UIApplication: NSObject {
  public enum State { case active, inactive, background }
  public static let shared = UIApplication()
  public var applicationState = State.active
  public var connectedScenes = Set<UIScene>()
  public var windows: [UIWindow] = []
}

public enum UIAccessibility {
  public enum Notification { case screenChanged }
  public static func post(notification: Notification, argument: Any?) {}
}
