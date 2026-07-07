//
//  RNPylonChatView.swift
//  RNPylonChat
//
//  Wrapper around PylonChatView for React Native
//

import Foundation
import UIKit
import React
import WebKit

// Import PylonChat from parent directory
// Note: PylonChat files will be added to Xcode project from ../../ios/PylonChat/

@objc public class RNPylonChatView: UIView {

    private var pylonChatView: PylonChatView?
    private var config: PylonConfig?
    private var user: PylonUser?
    private var needsRecreate: Bool = false

    // Config properties
    @objc public var appId: NSString = "" {
        didSet { updateConfig() }
    }

    @objc public var widgetBaseUrl: NSString? {
        didSet { updateConfig() }
    }

    @objc public var widgetScriptUrl: NSString? {
        didSet { updateConfig() }
    }

    @objc public var enableLogging: Bool = true {
        didSet { updateConfig() }
    }

    @objc public var debugMode: Bool = false {
        didSet { updateConfig() }
    }

    @objc public var primaryColor: NSString? {
        didSet { updateConfig() }
    }

    // User properties
    @objc public var userEmail: NSString? {
        didSet { updateUser() }
    }

    @objc public var userName: NSString? {
        didSet { updateUser() }
    }

    @objc public var userAvatarUrl: NSString? {
        didSet { updateUser() }
    }

    @objc public var userEmailHash: NSString? {
        didSet { updateUser() }
    }

    @objc public var userAccountId: NSString? {
        didSet { updateUser() }
    }

    @objc public var userAccountExternalId: NSString? {
        didSet { updateUser() }
    }

    // Safe area top inset for coordinate space adjustment
    @objc public var topInset: NSNumber = 0 {
        didSet {
            if let pylonView = pylonChatView {
                pylonView.topInset = CGFloat(truncating: topInset)
            }
        }
    }

    // Event callbacks - renamed to avoid collision with PylonChatListener methods
    @objc public var rctOnPylonLoaded: RCTBubblingEventBlock?
    @objc public var rctOnPylonInitialized: RCTBubblingEventBlock?
    @objc public var rctOnPylonReady: RCTBubblingEventBlock?
    @objc public var rctOnChatOpened: RCTBubblingEventBlock?
    @objc public var rctOnChatClosed: RCTBubblingEventBlock?
    @objc public var rctOnUnreadCountChanged: RCTBubblingEventBlock?
    @objc public var rctOnMessageReceived: RCTBubblingEventBlock?
    @objc public var rctOnPylonError: RCTBubblingEventBlock?

    public override init(frame: CGRect) {
        super.init(frame: frame)
        setupView()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupView()
    }

    private func setupView() {
        backgroundColor = .clear
        RNPylonChatCommands.currentView = self
    }

    // Override pointInside to make React Native call hitTest
    public override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        return true
    }

    // Forward hit testing to the embedded PylonChatView
    public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if let pylonView = pylonChatView {
            let convertedPoint = convert(point, to: pylonView)
            return pylonView.hitTest(convertedPoint, with: event)
        }
        return nil
    }

    private func updateConfig() {
        guard (appId as String).isEmpty == false else { return }

        config = PylonConfig(
            appId: appId as String,
            enableLogging: enableLogging,
            primaryColor: primaryColor as String?,
            debugMode: debugMode,
            widgetBaseUrl: widgetBaseUrl as String?,
            widgetScriptUrl: widgetScriptUrl as String?
        )

        recreatePylonView()
    }

    private func updateUser() {
        guard let email = userEmail as String?,
              let name = userName as String? else { return }

        user = PylonUser(
            email: email,
            name: name,
            avatarUrl: userAvatarUrl as String?,
            emailHash: userEmailHash as String?,
            accountId: userAccountId as String?,
            accountExternalId: userAccountExternalId as String?
        )

        recreatePylonView()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        if needsRecreate && bounds.size.width > 0 && bounds.size.height > 0 {
            recreatePylonView()
        }
    }

    private func recreatePylonView() {
        guard let config = config, let user = user else { return }

        // Defer creation until the view has non-zero bounds so the WebView
        // gets a proper viewport size and element position queries succeed.
        if bounds.size.width == 0 || bounds.size.height == 0 {
            needsRecreate = true
            return
        }
        needsRecreate = false

        pylonChatView?.removeFromSuperview()

        let newView = PylonChatView(config: config, user: user)
        newView.listener = self
        newView.topInset = CGFloat(truncating: topInset)
        newView.translatesAutoresizingMaskIntoConstraints = false

        addSubview(newView)

        NSLayoutConstraint.activate([
            newView.topAnchor.constraint(equalTo: topAnchor),
            newView.leadingAnchor.constraint(equalTo: leadingAnchor),
            newView.trailingAnchor.constraint(equalTo: trailingAnchor),
            newView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])

        pylonChatView = newView

        setNeedsLayout()
        layoutIfNeeded()
    }

    // Imperative methods (called from React Native and Fabric wrapper)
    @objc public func refreshInteractiveBounds() {
        pylonChatView?.refreshInteractiveBounds()
    }

    @objc public func openChat() {
        pylonChatView?.openChat()
        scheduleRefreshBounds()
    }

    @objc public func closeChat() {
        pylonChatView?.closeChat()
        scheduleRefreshBounds()
    }

    @objc public func showChatBubble() {
        pylonChatView?.showChatBubble()
        scheduleRefreshBounds()
    }

    @objc public func hideChatBubble() {
        pylonChatView?.hideChatBubble()
        scheduleRefreshBounds()
    }

    private func scheduleRefreshBounds(retryCount: Int = 3, delay: TimeInterval = 0.3) {
        guard retryCount > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, let pylonView = self.pylonChatView else { return }
            pylonView.refreshInteractiveBounds()
            // If bounds are still empty after this refresh, retry with a longer delay.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self = self else { return }
                if !self.hasNonZeroBounds() {
                    self.scheduleRefreshBounds(retryCount: retryCount - 1, delay: delay * 2)
                }
            }
        }
    }

    private func hasNonZeroBounds() -> Bool {
        return pylonChatView?.hasNonZeroInteractiveBounds() ?? false
    }

    @objc public func showNewMessage(_ message: String, isHtml: Bool) {
        pylonChatView?.showNewMessage(message, isHtml: isHtml)
    }

    @objc public func setNewIssueCustomFields(_ fields: [String: Any]) {
        pylonChatView?.setNewIssueCustomFields(fields)
    }

    @objc public func setTicketFormFields(_ fields: [String: Any]) {
        pylonChatView?.setTicketFormFields(fields)
    }

    @objc public func updateEmailHash(_ emailHash: String?) {
        pylonChatView?.updateEmailHash(emailHash)
    }

    @objc public func showTicketForm(_ slug: String) {
        pylonChatView?.showTicketForm(slug)
    }

    @objc public func showKnowledgeBaseArticle(_ articleId: String) {
        pylonChatView?.showKnowledgeBaseArticle(articleId)
    }

    @objc public func clickElementAtSelector(_ selector: String) {
        // No-op on iOS — clickElementBySelector is Android-only.
        // iOS uses native hitTest for touch routing instead.
    }
}

// MARK: - PylonChatListener
extension RNPylonChatView: PylonChatListener {
    public func onPylonLoaded() {
        rctOnPylonLoaded?([:])
        scheduleRefreshBounds()
    }

    public func onPylonInitialized() {
        rctOnPylonInitialized?([:])
    }

    public func onPylonReady() {
        rctOnPylonReady?([:])
        scheduleRefreshBounds()
    }

    public func onMessageReceived(message: String) {
        rctOnMessageReceived?(["message": message])
    }

    public func onChatOpened() {
        rctOnChatOpened?([:])
    }

    public func onChatClosed(wasOpen: Bool) {
        rctOnChatClosed?(["wasOpen": wasOpen])
    }

    public func onPylonError(error: String) {
        rctOnPylonError?(["error": error])
    }

    public func onUnreadCountChanged(count: Int) {
        rctOnUnreadCountChanged?(["count": count])
    }
}

// MARK: - Imperative method helpers
extension RNPylonChatViewManager {
    @objc func openChat(_ reactTag: NSNumber) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.openChat()
        }
    }

    @objc func closeChat(_ reactTag: NSNumber) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.closeChat()
        }
    }

    @objc func showChatBubble(_ reactTag: NSNumber) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.showChatBubble()
        }
    }

    @objc func hideChatBubble(_ reactTag: NSNumber) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.hideChatBubble()
        }
    }

    @objc func showNewMessage(_ reactTag: NSNumber, message: NSString, isHtml: Bool) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.showNewMessage(message as String, isHtml: isHtml)
        }
    }

    @objc func setNewIssueCustomFields(_ reactTag: NSNumber, fields: NSDictionary) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.setNewIssueCustomFields(fields as! [String: Any])
        }
    }

    @objc func setTicketFormFields(_ reactTag: NSNumber, fields: NSDictionary) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.setTicketFormFields(fields as! [String: Any])
        }
    }

    @objc func updateEmailHash(_ reactTag: NSNumber, emailHash: NSString?) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.updateEmailHash(emailHash as String?)
        }
    }

    @objc func showTicketForm(_ reactTag: NSNumber, slug: NSString) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.showTicketForm(slug as String)
        }
    }

    @objc func showKnowledgeBaseArticle(_ reactTag: NSNumber, articleId: NSString) {
        bridge.uiManager.addUIBlock { _, viewRegistry in
            guard let view = viewRegistry?[reactTag] as? RNPylonChatView else { return }
            view.showKnowledgeBaseArticle(articleId as String)
        }
    }
}
