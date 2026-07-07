package com.pylon.chatwidget

import java.net.URLEncoder

/**
 * Immutable configuration for the Pylon SDK. Use the [Builder] to customise
 * the settings and pass the result to [Pylon.initialize].
 */
data class PylonConfig internal constructor(
    val appId: String,
    val enableLogging: Boolean,
    val primaryColor: String?,
    val debugMode: Boolean,
    val widgetBaseUrl: String,
    val widgetScriptUrl: String
) {

    class Builder internal constructor(private val appId: String) {
        var enableLogging: Boolean = true
        var primaryColor: String? = null
        var debugMode: Boolean = false
        var widgetBaseUrl: String = DEFAULT_WIDGET_BASE_URL
        var widgetScriptUrl: String = defaultScriptUrl(appId)

        internal fun build(): PylonConfig {
            val scriptUrl = widgetScriptUrl.ifBlank { defaultScriptUrl(appId) }
            return PylonConfig(
                appId = appId,
                enableLogging = enableLogging,
                primaryColor = primaryColor,
                debugMode = debugMode,
                widgetBaseUrl = widgetBaseUrl.ifBlank { DEFAULT_WIDGET_BASE_URL },
                widgetScriptUrl = scriptUrl
            )
        }
    }

    companion object {
        private const val DEFAULT_WIDGET_BASE_URL = "https://widget.usepylon.com"

        private fun defaultScriptUrl(appId: String): String {
            val encodedAppId = URLEncoder.encode(appId, "UTF-8")
            return "$DEFAULT_WIDGET_BASE_URL/widget/$encodedAppId"
        }

        fun build(appId: String, block: Builder.() -> Unit = {}): PylonConfig {
            return Builder(appId).apply(block).build()
        }

        fun from(existing: PylonConfig, block: Builder.() -> Unit): PylonConfig {
            val builder = Builder(existing.appId).apply {
                enableLogging = existing.enableLogging
                primaryColor = existing.primaryColor
                debugMode = existing.debugMode
                widgetBaseUrl = existing.widgetBaseUrl
                widgetScriptUrl = existing.widgetScriptUrl
            }
            builder.block()
            return builder.build()
        }
    }
}
