package com.pylon.chatwidget

/**
 * Listener interface for Pylon widget events
 */
interface PylonChatListener {
    /**
     * Called when the Pylon widget has finished loading
     */
    fun onPylonLoaded()

    /**
     * Called when Pylon is initialized with user data
     */
    fun onPylonInitialized()

    /**
     * Called when Pylon JavaScript is ready
     */
    fun onPylonReady()

    /**
     * Called when a message is received
     */
    fun onMessageReceived(message: String)

    /**
     * Called when the chat is opened
     */
    fun onChatOpened()

    /**
     * Called when the chat is closed
     */
    fun onChatClosed()

    /**
     * Called when there's an error loading Pylon
     */
    fun onPylonError(error: String)

    /**
     * Called when a file chooser is launched.
     * This is only called when PylonChat is used from a non-Activity context.
     *
     * Developers can simply forward activity results to [Pylon.handleActivityResult]
     * and ignore request codes altogether. The provided request code is only kept
     * for backwards compatibility.
     *
     * @param requestCode The legacy request code identifier.
     */
    fun onFileChooserLaunched(requestCode: Int) {
        // Default implementation - can be overridden if needed
    }

    /**
     * Called whenever the unread message count changes.
     */
    fun onUnreadCountChanged(unreadCount: Int) {
        // Default implementation - can be overridden if needed
    }

    /**
     * Called whenever interactive element bounds change.
     * Used by React Native to position proxy touch targets.
     *
     * @param selector The CSS selector of the interactive element
     * @param left The left coordinate in pixels
     * @param top The top coordinate in pixels
     * @param right The right coordinate in pixels
     * @param bottom The bottom coordinate in pixels
     */
    fun onInteractiveBoundsChanged(selector: String, left: Float, top: Float, right: Float, bottom: Float) {
        // Default implementation - can be overridden if needed
    }
}
