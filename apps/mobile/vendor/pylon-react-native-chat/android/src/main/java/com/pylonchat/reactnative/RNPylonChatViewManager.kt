package com.pylonchat.reactnative

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.common.MapBuilder
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.RNPylonChatViewManagerDelegate
import com.facebook.react.viewmanagers.RNPylonChatViewManagerInterface

@ReactModule(name = RNPylonChatViewManager.REACT_CLASS)
class RNPylonChatViewManager : SimpleViewManager<RNPylonChatView>(),
    RNPylonChatViewManagerInterface<RNPylonChatView> {

    companion object {
        const val REACT_CLASS = "RNPylonChatView"
        const val COMMAND_OPEN_CHAT = 1
        const val COMMAND_CLOSE_CHAT = 2
        const val COMMAND_SHOW_BUBBLE = 3
        const val COMMAND_HIDE_BUBBLE = 4
        const val COMMAND_SHOW_NEW_MESSAGE = 5
        const val COMMAND_SET_CUSTOM_FIELDS = 6
        const val COMMAND_SET_TICKET_FIELDS = 7
        const val COMMAND_UPDATE_EMAIL_HASH = 8
        const val COMMAND_SHOW_TICKET_FORM = 9
        const val COMMAND_SHOW_KB_ARTICLE = 10
        const val COMMAND_CLICK_ELEMENT_AT_SELECTOR = 11
    }

    private val mDelegate = RNPylonChatViewManagerDelegate(this)

    override fun getDelegate(): ViewManagerDelegate<RNPylonChatView> = mDelegate

    override fun getName(): String = REACT_CLASS

    override fun createViewInstance(reactContext: ThemedReactContext): RNPylonChatView {
        return RNPylonChatView(reactContext)
    }

    @ReactProp(name = "appId")
    override fun setAppId(view: RNPylonChatView, appId: String?) {
        view.appId = appId
    }

    @ReactProp(name = "widgetBaseUrl")
    override fun setWidgetBaseUrl(view: RNPylonChatView, url: String?) {
        view.widgetBaseUrl = url
    }

    @ReactProp(name = "widgetScriptUrl")
    override fun setWidgetScriptUrl(view: RNPylonChatView, url: String?) {
        view.widgetScriptUrl = url
    }

    @ReactProp(name = "enableLogging")
    override fun setEnableLogging(view: RNPylonChatView, enabled: Boolean) {
        view.enableLogging = enabled
    }

    @ReactProp(name = "debugMode")
    override fun setDebugMode(view: RNPylonChatView, enabled: Boolean) {
        view.debugMode = enabled
    }

    @ReactProp(name = "primaryColor")
    override fun setPrimaryColor(view: RNPylonChatView, color: String?) {
        view.primaryColor = color
    }

    @ReactProp(name = "userEmail")
    override fun setUserEmail(view: RNPylonChatView, email: String?) {
        view.userEmail = email
    }

    @ReactProp(name = "userName")
    override fun setUserName(view: RNPylonChatView, name: String?) {
        view.userName = name
    }

    @ReactProp(name = "userAvatarUrl")
    override fun setUserAvatarUrl(view: RNPylonChatView, url: String?) {
        view.userAvatarUrl = url
    }

    @ReactProp(name = "userEmailHash")
    override fun setUserEmailHash(view: RNPylonChatView, hash: String?) {
        view.userEmailHash = hash
    }

    @ReactProp(name = "userAccountId")
    override fun setUserAccountId(view: RNPylonChatView, id: String?) {
        view.userAccountId = id
    }

    @ReactProp(name = "userAccountExternalId")
    override fun setUserAccountExternalId(view: RNPylonChatView, id: String?) {
        view.userAccountExternalId = id
    }

    @ReactProp(name = "topInset")
    override fun setTopInset(view: RNPylonChatView, topInset: Double) {
        view.topInset = topInset.toFloat()
    }

    @ReactProp(name = "pointerEvents")
    fun setPointerEvents(view: RNPylonChatView, pointerEvents: String?) {
        val mode = pointerEvents ?: "auto"
        view.setPointerEventsMode(mode)

        when (mode) {
            "none" -> {
                view.isClickable = false
                view.isFocusable = false
            }
            "auto" -> {
                view.isClickable = true
                view.isFocusable = true
            }
            "box-none" -> {
                view.isClickable = false
                view.isFocusable = false
            }
            "box-only" -> {
                view.isClickable = true
                view.isFocusable = true
            }
        }
    }

    override fun openChat(view: RNPylonChatView) {
        view.openChat()
    }

    override fun closeChat(view: RNPylonChatView) {
        view.closeChat()
    }

    override fun showChatBubble(view: RNPylonChatView) {
        view.showChatBubble()
    }

    override fun hideChatBubble(view: RNPylonChatView) {
        view.hideChatBubble()
    }

    override fun showNewMessage(view: RNPylonChatView, message: String, isHtml: Boolean) {
        view.showNewMessage(message, isHtml)
    }

    override fun updateEmailHash(view: RNPylonChatView, emailHash: String) {
        view.updateEmailHash(emailHash)
    }

    override fun showTicketForm(view: RNPylonChatView, slug: String) {
        view.showTicketForm(slug)
    }

    override fun showKnowledgeBaseArticle(view: RNPylonChatView, articleId: String) {
        view.showKnowledgeBaseArticle(articleId)
    }

    override fun clickElementAtSelector(view: RNPylonChatView, selector: String) {
        view.clickElementAtSelector(selector)
    }

    override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
        return MapBuilder.builder<String, Any>()
            .put("onPylonLoaded", MapBuilder.of("registrationName", "onPylonLoaded"))
            .put("onPylonInitialized", MapBuilder.of("registrationName", "onPylonInitialized"))
            .put("onPylonReady", MapBuilder.of("registrationName", "onPylonReady"))
            .put("onChatOpened", MapBuilder.of("registrationName", "onChatOpened"))
            .put("onChatClosed", MapBuilder.of("registrationName", "onChatClosed"))
            .put("onUnreadCountChanged", MapBuilder.of("registrationName", "onUnreadCountChanged"))
            .put("onMessageReceived", MapBuilder.of("registrationName", "onMessageReceived"))
            .put("onPylonError", MapBuilder.of("registrationName", "onPylonError"))
            .put("onInteractiveBoundsChanged", MapBuilder.of("registrationName", "onInteractiveBoundsChanged"))
            .build() as MutableMap<String, Any>
    }

    override fun getCommandsMap(): MutableMap<String, Int> {
        return MapBuilder.builder<String, Int>()
            .put("openChat", COMMAND_OPEN_CHAT)
            .put("closeChat", COMMAND_CLOSE_CHAT)
            .put("showChatBubble", COMMAND_SHOW_BUBBLE)
            .put("hideChatBubble", COMMAND_HIDE_BUBBLE)
            .put("showNewMessage", COMMAND_SHOW_NEW_MESSAGE)
            .put("setNewIssueCustomFields", COMMAND_SET_CUSTOM_FIELDS)
            .put("setTicketFormFields", COMMAND_SET_TICKET_FIELDS)
            .put("updateEmailHash", COMMAND_UPDATE_EMAIL_HASH)
            .put("showTicketForm", COMMAND_SHOW_TICKET_FORM)
            .put("showKnowledgeBaseArticle", COMMAND_SHOW_KB_ARTICLE)
            .put("clickElementAtSelector", COMMAND_CLICK_ELEMENT_AT_SELECTOR)
            .build() as MutableMap<String, Int>
    }

    override fun receiveCommand(view: RNPylonChatView, commandId: String, args: ReadableArray?) {
        when (commandId) {
            "openChat" -> view.openChat()
            "closeChat" -> view.closeChat()
            "showChatBubble" -> view.showChatBubble()
            "hideChatBubble" -> view.hideChatBubble()
            "showNewMessage" -> {
                val message = args?.getString(0) ?: return
                val isHtml = args.getBoolean(1)
                view.showNewMessage(message, isHtml)
            }
            "setNewIssueCustomFields" -> {
                val fields = args?.getMap(0) ?: return
                view.setNewIssueCustomFields(fields.toHashMap())
            }
            "setTicketFormFields" -> {
                val fields = args?.getMap(0) ?: return
                view.setTicketFormFields(fields.toHashMap())
            }
            "updateEmailHash" -> {
                val hash = args?.getString(0)
                view.updateEmailHash(hash)
            }
            "showTicketForm" -> {
                val slug = args?.getString(0) ?: return
                view.showTicketForm(slug)
            }
            "showKnowledgeBaseArticle" -> {
                val articleId = args?.getString(0) ?: return
                view.showKnowledgeBaseArticle(articleId)
            }
            "clickElementAtSelector" -> {
                val selector = args?.getString(0) ?: return
                view.clickElementAtSelector(selector)
            }
        }
    }
}
