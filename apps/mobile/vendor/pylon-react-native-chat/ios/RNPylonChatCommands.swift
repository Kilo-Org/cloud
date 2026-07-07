import Foundation
import React

@objc(RNPylonChatCommands)
class RNPylonChatCommands: NSObject {

    /// Set by RNPylonChatView when it mounts so commands know where to forward.
    static weak var currentView: RNPylonChatView?

    @objc static func requiresMainQueueSetup() -> Bool { return false }

    @objc func openChat() {
        DispatchQueue.main.async { Self.currentView?.openChat() }
    }

    @objc func closeChat() {
        DispatchQueue.main.async { Self.currentView?.closeChat() }
    }

    @objc func showChatBubble() {
        DispatchQueue.main.async { Self.currentView?.showChatBubble() }
    }

    @objc func hideChatBubble() {
        DispatchQueue.main.async { Self.currentView?.hideChatBubble() }
    }

    @objc func showNewMessage(_ message: NSString, isHtml: Bool) {
        DispatchQueue.main.async { Self.currentView?.showNewMessage(message as String, isHtml: isHtml) }
    }

    @objc func setNewIssueCustomFields(_ fields: NSDictionary) {
        DispatchQueue.main.async {
            Self.currentView?.setNewIssueCustomFields(fields as! [String: Any])
        }
    }

    @objc func setTicketFormFields(_ fields: NSDictionary) {
        DispatchQueue.main.async {
            Self.currentView?.setTicketFormFields(fields as! [String: Any])
        }
    }

    @objc func updateEmailHash(_ emailHash: NSString?) {
        DispatchQueue.main.async {
            Self.currentView?.updateEmailHash(emailHash as String?)
        }
    }

    @objc func showTicketForm(_ slug: NSString) {
        DispatchQueue.main.async { Self.currentView?.showTicketForm(slug as String) }
    }

    @objc func showKnowledgeBaseArticle(_ articleId: NSString) {
        DispatchQueue.main.async {
            Self.currentView?.showKnowledgeBaseArticle(articleId as String)
        }
    }
}
