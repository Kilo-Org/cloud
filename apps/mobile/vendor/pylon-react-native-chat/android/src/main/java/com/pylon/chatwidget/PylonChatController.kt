package com.pylon.chatwidget

/**
 * Lightweight handle returned by [Pylon.createChat] so developers can interact
 * with the underlying [PylonChat] view without keeping a direct reference to
 * the view class (useful when wiring things in Jetpack Compose or XML layouts).
 */
class PylonChatController internal constructor(
    val view: PylonChat
) {

    fun setListener(listener: PylonChatListener?) {
        view.setListener(listener)
    }

    fun openChat() {
        view.openChat()
    }

    fun closeChat() {
        view.closeChat()
    }

    fun showChatBubble() {
        view.showChatBubble()
    }

    fun hideChatBubble() {
        view.hideChatBubble()
    }

    fun updateUser(user: PylonUser) {
        view.updateUser(user)
    }

    fun setNewIssueCustomFields(fields: Map<String, Any?>) {
        view.setNewIssueCustomFields(fields)
    }

    fun setTicketFormFields(fields: Map<String, Any?>) {
        view.setTicketFormFields(fields)
    }

    fun showNewMessage(message: String, isHtml: Boolean = false) {
        view.showNewMessage(message, isHtml)
    }

    fun showTicketForm(ticketFormSlug: String) {
        view.showTicketForm(ticketFormSlug)
    }

    fun showKnowledgeBaseArticle(articleId: String) {
        view.showKnowledgeBaseArticle(articleId)
    }

    fun setEmailHash(emailHash: String?) {
        view.updateEmailHash(emailHash)
    }

    fun destroy() {
        view.destroy()
    }
}
