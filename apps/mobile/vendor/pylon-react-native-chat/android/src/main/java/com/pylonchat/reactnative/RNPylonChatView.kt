package com.pylonchat.reactnative

import android.content.Context
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.pylon.chatwidget.PylonChatListener
import com.pylon.chatwidget.PylonChatView
import com.pylon.chatwidget.PylonConfig
import com.pylon.chatwidget.PylonUser

/**
 * React Native wrapper for PylonChatView.
 * This is kept as minimal as possible to avoid interfering with touch pass-through.
 */
class RNPylonChatView(context: Context) : FrameLayout(context) {
    
    private var pylonChatView: PylonChatView? = null
    private var config: PylonConfig? = null
    private var user: PylonUser? = null
    
    // Config properties
    var appId: String? = null
        set(value) {
            field = value
            updateConfig()
        }
    
    var widgetBaseUrl: String? = null
        set(value) {
            field = value
            updateConfig()
        }
    
    var widgetScriptUrl: String? = null
        set(value) {
            field = value
            updateConfig()
        }
    
    var enableLogging: Boolean = true
        set(value) {
            field = value
            updateConfig()
        }
    
    var debugMode: Boolean = false
        set(value) {
            field = value
            updateConfig()
        }
    
    var primaryColor: String? = null
        set(value) {
            field = value
            updateConfig()
        }
    
    // User properties
    var userEmail: String? = null
        set(value) {
            field = value
            updateUser()
        }
    
    var userName: String? = null
        set(value) {
            field = value
            updateUser()
        }
    
    var userAvatarUrl: String? = null
        set(value) {
            field = value
            updateUser()
        }
    
    var userEmailHash: String? = null
        set(value) {
            field = value
            updateUser()
        }
    
    var userAccountId: String? = null
        set(value) {
            field = value
            updateUser()
        }
    
    var userAccountExternalId: String? = null
        set(value) {
            field = value
            updateUser()
        }

    var topInset: Float = 0f
        set(value) {
            field = value
        }

    init {
        layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    }
    
    // Track pointer events setting
    private var pointerEventsMode = "auto"
    
    fun setPointerEventsMode(mode: String) {
        pointerEventsMode = mode
    }
    
    /**
     * Touch routing for pointerEvents support.
     *
     * Under Fabric (New Architecture), React's JSTouchDispatcher intercepts touches
     * on ancestor views before they reach native children like our WebView. When the
     * PylonChatView determines it should handle a touch (bubble tap or open chat window),
     * we call requestDisallowInterceptTouchEvent to prevent React from stealing the
     * touch, then dispatch directly to the PylonChatView.
     */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        when (pointerEventsMode) {
            "none" -> {
                return false
            }
            "box-none" -> {
                val pylon = pylonChatView ?: return false
                if (pylon.shouldHandleTouchAt(ev.x, ev.y)) {
                    if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
                        parent?.requestDisallowInterceptTouchEvent(true)
                    }
                    return pylon.dispatchTouchEvent(ev)
                }
                return false
            }
            "box-only" -> {
                return onTouchEvent(ev)
            }
            else -> {
                return super.dispatchTouchEvent(ev)
            }
        }
    }

    private fun updateConfig() {
        val id = appId ?: return
        
        config = PylonConfig.build(id) {
            this.enableLogging = this@RNPylonChatView.enableLogging
            this.primaryColor = this@RNPylonChatView.primaryColor
            this.debugMode = this@RNPylonChatView.debugMode
            this@RNPylonChatView.widgetBaseUrl?.let { this.widgetBaseUrl = it }
            this@RNPylonChatView.widgetScriptUrl?.let { this.widgetScriptUrl = it }
        }
        
        recreatePylonView()
    }
    
    private fun updateUser() {
        val email = userEmail ?: return
        val name = userName ?: return
        
        user = PylonUser(
            email = email,
            name = name,
            avatarUrl = userAvatarUrl,
            emailHash = userEmailHash,
            accountId = userAccountId,
            accountExternalId = userAccountExternalId
        )
        
        recreatePylonView()
    }
    
    private fun recreatePylonView() {
        val cfg = config ?: return
        val usr = user ?: return
        
        // Remove old view
        pylonChatView?.let { removeView(it) }
        
        // Create new PylonChatView
        val newView = PylonChatView(context, cfg, usr)
        newView.setListener(object : PylonChatListener {
            override fun onPylonLoaded() {
                sendEvent("onPylonLoaded", Arguments.createMap())
            }
            
            override fun onPylonInitialized() {
                sendEvent("onPylonInitialized", Arguments.createMap())
            }
            
            override fun onPylonReady() {
                sendEvent("onPylonReady", Arguments.createMap())
            }
            
            override fun onMessageReceived(message: String) {
                val params = Arguments.createMap()
                params.putString("message", message)
                sendEvent("onMessageReceived", params)
            }
            
            override fun onChatOpened() {
                sendEvent("onChatOpened", Arguments.createMap())
            }
            
            override fun onChatClosed() {
                val params = Arguments.createMap()
                params.putBoolean("wasOpen", true)
                sendEvent("onChatClosed", params)
            }
            
            override fun onInteractiveBoundsChanged(selector: String, left: Float, top: Float, right: Float, bottom: Float) {
                // Convert pixels to density-independent pixels (dp) for React Native.
                val density = resources.displayMetrics.density
                val params = Arguments.createMap()
                params.putString("selector", selector)
                params.putDouble("left", (left / density).toDouble())
                params.putDouble("top", (top / density).toDouble())
                params.putDouble("right", (right / density).toDouble())
                params.putDouble("bottom", (bottom / density).toDouble())
                sendEvent("onInteractiveBoundsChanged", params)
            }
            
            override fun onPylonError(error: String) {
                val params = Arguments.createMap()
                params.putString("error", error)
                sendEvent("onPylonError", params)
            }
            
            override fun onUnreadCountChanged(count: Int) {
                val params = Arguments.createMap()
                params.putInt("count", count)
                sendEvent("onUnreadCountChanged", params)
            }
            
            override fun onFileChooserLaunched(requestCode: Int) {
                // Handle file chooser if needed
            }
        })
        
        newView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        addView(newView)
        pylonChatView = newView
    }
    
    private class PylonEvent(
        surfaceId: Int,
        viewId: Int,
        private val name: String,
        private val data: WritableMap
    ) : Event<PylonEvent>(surfaceId, viewId) {
        override fun getEventName(): String = name
        override fun getEventData(): WritableMap = data
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        val reactContext = context as ReactContext
        val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
        dispatcher?.dispatchEvent(PylonEvent(surfaceId, id, eventName, params))
    }
    
    // Imperative methods
    fun openChat() {
        pylonChatView?.openChat()
    }
    
    fun closeChat() {
        pylonChatView?.closeChat()
    }
    
    fun showChatBubble() {
        pylonChatView?.showChatBubble()
    }
    
    fun hideChatBubble() {
        pylonChatView?.hideChatBubble()
    }
    
    fun showNewMessage(message: String, isHtml: Boolean) {
        pylonChatView?.showNewMessage(message, isHtml)
    }
    
    fun setNewIssueCustomFields(fields: Map<String, Any?>) {
        @Suppress("UNCHECKED_CAST")
        pylonChatView?.setNewIssueCustomFields(fields as Map<String, Any>)
    }

    fun setTicketFormFields(fields: Map<String, Any?>) {
        @Suppress("UNCHECKED_CAST")
        pylonChatView?.setTicketFormFields(fields as Map<String, Any>)
    }
    
    fun updateEmailHash(emailHash: String?) {
        pylonChatView?.setEmailHash(emailHash)
    }
    
    fun showTicketForm(slug: String) {
        pylonChatView?.showTicketForm(slug)
    }
    
    fun showKnowledgeBaseArticle(articleId: String) {
        pylonChatView?.showKnowledgeBaseArticle(articleId)
    }
    
    fun clickElementAtSelector(selector: String) {
        // Trigger a click on the element with the given ID selector.
        // This is used for Android's proxy-based touch pass-through system.
        pylonChatView?.clickElementBySelector(selector)
    }
}

