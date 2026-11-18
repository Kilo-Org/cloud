package com.kilocode.kilosessionhandoff

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android's own continue-on-another-device entry point.
 *
 * iOS advertises the session through an `NSUserActivity`; Android has no
 * proximity-handoff API, so this module publishes the session as the app's
 * single dynamic launcher shortcut. Tapping it opens the session's universal
 * link, which is the same link the iOS activity advertises and the same one the
 * copy-link action produces.
 *
 * The dynamic shortcut set is replaced on every `publishSession`, so the app
 * always advertises exactly the session on screen and `clearSession` leaves
 * nothing behind. `ShortcutManager` only exists from API 25 (N_MR1); below
 * that, and when the launcher exposes no shortcut slots, every call is a no-op
 * and the session screen is unaffected.
 */
class KiloSessionHandoffModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KiloSessionHandoff")

    Function("publishSession") { url: String, title: String, anchorMessageId: String? ->
      publish(url, title, anchorMessageId)
    }

    Function("clearSession") {
      clear()
    }
  }

  private fun shortcutManager(context: Context): ShortcutManager? {
    // ShortcutManager is API 25 (N_MR1); older devices get no entry point.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
      return null
    }
    return context.getSystemService(ShortcutManager::class.java)
  }

  private fun publish(url: String, title: String, anchorMessageId: String?) {
    val context = appContext.reactContext ?: return
    val manager = shortcutManager(context) ?: return

    // A launcher that offers no dynamic slots rejects a non-empty list.
    if (manager.maxShortcutCountPerActivity <= 0) {
      return
    }

    try {
      manager.setDynamicShortcuts(listOf(newShortcut(context, url, title, anchorMessageId)))
    } catch (ignored: RuntimeException) {
      // A launcher that refuses the update keeps the previous shortcut; losing
      // the entry point must never fail the session screen.
      Log.w(TAG, "Could not publish the session shortcut", ignored)
    }
  }

  private fun clear() {
    val context = appContext.reactContext ?: return
    val manager = shortcutManager(context) ?: return

    try {
      manager.removeDynamicShortcuts(listOf(SHORTCUT_ID))
    } catch (ignored: RuntimeException) {
      Log.w(TAG, "Could not clear the session shortcut", ignored)
    }
  }

  private fun newShortcut(
    context: Context,
    url: String,
    title: String,
    anchorMessageId: String?
  ): ShortcutInfo {
    // The package-scoped intent resolves through the app's own universal-link
    // filter, so a tap continues in Kilo and never hands the link to a browser.
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
      setPackage(context.packageName)
      putExtra(EXTRA_ANCHOR_MESSAGE_ID, anchorMessageId)
    }

    val builder = ShortcutInfo.Builder(context, SHORTCUT_ID)
      .setShortLabel(title)
      .setLongLabel(title)
      .setIntent(intent)

    // A library module cannot reach the app's R; the launcher entry reuses the
    // application icon. `0` means the app declares none, which is not an error.
    val iconResource = context.applicationInfo.icon
    if (iconResource != 0) {
      builder.setIcon(Icon.createWithResource(context, iconResource))
    }

    return builder.build()
  }

  private companion object {
    const val TAG = "KiloSessionHandoff"
    const val SHORTCUT_ID = "kilo-continue-session"
    const val EXTRA_ANCHOR_MESSAGE_ID = "kilo.anchor_message_id"
  }
}
