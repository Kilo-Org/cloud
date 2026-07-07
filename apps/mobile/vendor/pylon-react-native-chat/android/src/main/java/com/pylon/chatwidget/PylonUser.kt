package com.pylon.chatwidget

/**
 * User information for Pylon Chat
 */
data class PylonUser(
    val email: String,
    val name: String,
    val avatarUrl: String? = null,
    val emailHash: String? = null,
    val accountId: String? = null,
    val accountExternalId: String? = null
) {

    class Builder internal constructor(
        private val email: String,
        private val name: String
    ) {
        var avatarUrl: String? = null
        var emailHash: String? = null
        var accountId: String? = null
        var accountExternalId: String? = null

        fun build(): PylonUser = PylonUser(
            email = email,
            name = name,
            avatarUrl = avatarUrl,
            emailHash = emailHash,
            accountId = accountId,
            accountExternalId = accountExternalId
        )
    }

    companion object {
        @JvmStatic
        @JvmOverloads
        fun build(email: String, name: String, block: Builder.() -> Unit = {}): PylonUser {
            return Builder(email, name).apply(block).build()
        }
    }
}
