package com.pylon.chatwidget

import android.content.Context
import android.content.Intent

/**
 * Entry point for configuring and interacting with the Pylon SDK.
 *
 * The object keeps the SDK configuration and user session in memory and exposes
 * a couple of convenience helpers so app developers do not have to wire
 * everything manually.
 */
object Pylon {

    private data class State(
        val appContext: Context,
        val config: PylonConfig,
        val user: PylonUser?
    )

    @Volatile
    private var state: State? = null

    /**
     * Initialize the SDK with the bare minimum information (the App ID). You
     * can optionally customise the configuration via the [block].
     */
    @JvmStatic
    @JvmOverloads
    fun initialize(context: Context, appId: String, block: PylonConfig.Builder.() -> Unit = {}) {
        val config = PylonConfig.build(appId, block)
        setState(context.applicationContext, config, state?.user)
    }

    /**
     * Initialize the SDK with a previously built [PylonConfig] instance.
     */
    @JvmStatic
    fun initialize(context: Context, config: PylonConfig) {
        setState(context.applicationContext, config, state?.user)
    }

    /**
     * Update the active configuration while keeping the current user session.
     */
    @JvmStatic
    fun updateConfiguration(block: PylonConfig.Builder.() -> Unit) {
        val current = requireState()
        val updated = PylonConfig.from(current.config, block)
        state = current.copy(config = updated)
    }

    /**
     * Attach user information so the chat widget can identify the visitor.
     */
    @JvmStatic
    fun setUser(user: PylonUser) {
        val current = requireState()
        state = current.copy(user = user)
    }

    /**
     * Convenience overload to build the user object inline.
     */
    @JvmStatic
    @JvmOverloads
    fun setUser(email: String, name: String, block: PylonUser.Builder.() -> Unit = {}) {
        setUser(PylonUser.build(email, name, block))
    }

    /**
     * Clear any stored user information (useful on logout flows).
     */
    @JvmStatic
    fun clearUser() {
        val current = requireState()
        state = current.copy(user = null)
    }

    /**
     * Attach or update the identity verification hash as described in the Pylon
     * chat widget identity verification docs. Requires that a user has already
     * been set so we have an email to associate with the hash.
     */
    @JvmStatic
    fun setEmailHash(emailHash: String?) {
        val current = requireState()
        val user = current.user ?: error("Set user before calling setEmailHash().")
        state = current.copy(user = user.copy(emailHash = emailHash))
    }

    /**
     * Check whether the SDK has been initialised.
     */
    @JvmStatic
    fun isInitialized(): Boolean = state != null

    /**
     * Create a [PylonChatController] that wraps a [PylonChat] view with the current
     * configuration already wired in. The caller receives both the controller
     * (to show or hide the chat programmatically) and the view instance that can
     * be added to the UI hierarchy.
     */
    @JvmStatic
    @JvmOverloads
    fun createChat(context: Context, listener: PylonChatListener? = null): PylonChatController {
        val state = requireState()
        val chatView = PylonChat(context, state.config, state.user)
        listener?.let { chatView.setListener(it) }
        chatView.ensurePylonLoaded()
        return PylonChatController(chatView)
    }

    /**
     * Create a chat view with specific config and user (instance-based, no global state).
     */
    @JvmStatic
    @JvmOverloads
    fun createChat(context: Context, config: PylonConfig, user: PylonUser? = null, listener: PylonChatListener? = null): PylonChatController {
        val chatView = PylonChat(context, config, user)
        listener?.let { chatView.setListener(it) }
        chatView.ensurePylonLoaded()
        return PylonChatController(chatView)
    }

    internal fun requireConfig(): PylonConfig = requireState().config

    internal fun currentUser(): PylonUser? = state?.user

    /**
     * Convenience helper so apps can forward activity results without worrying about
     * request codes. Returns true when the SDK consumed the result.
     */
    @JvmStatic
    fun handleActivityResult(resultCode: Int, data: Intent?): Boolean {
        return PylonChat.handleActivityResult(resultCode, data)
    }

    private fun requireState(): State = state ?: error("Pylon SDK not initialised. Call Pylon.initialize() first.")

    @Synchronized
    private fun setState(context: Context, config: PylonConfig, user: PylonUser?) {
        state = State(
            appContext = context,
            config = config,
            user = user
        )
    }
}
