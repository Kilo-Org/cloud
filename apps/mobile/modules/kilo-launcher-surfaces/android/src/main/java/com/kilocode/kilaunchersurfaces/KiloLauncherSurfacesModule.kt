package com.kilocode.kilaunchersurfaces

import android.content.ComponentName
import android.content.Context
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.TileService
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * Local Expo module for the Android launcher surfaces: the dynamic app shortcuts
 * on the icon and the quick-settings tile.
 *
 * JS owns the URLs, the translated labels and the decision of when an agent waits;
 * this module owns the native caches and pins the launcher surfaces. The payload is
 * committed synchronously because [QuickSettingsTileService] reads it in a cold
 * process, and the shortcuts are published with `setDynamicShortcuts` so an action
 * whose url is null disappears from the launcher.
 *
 * App shortcuts are a framework API from API 25, so an API 24 device shows none;
 * the tile (API 24+) still works there.
 */
class KiloLauncherSurfacesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KiloLauncherSurfaces")

    Function("setSurfaces") { payloadJson: String ->
      cacheSurfaces(payloadJson)
    }

    Function("clearDynamicSurfaces") {
      clearDynamicSurfaces()
    }
  }

  // `AppContext` exposes only the React context. Every entry point runs from a JS
  // call, so losing it means the module cannot work at all.
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun cacheSurfaces(payloadJson: String) {
    val payload = JSONObject(payloadJson)
    val surfaces =
      CachedSurfaces(
        newAgentUrl = payload.stringOrNull(LauncherSurfacesStore.KEY_NEW_AGENT_URL),
        newAgentLabel = payload.stringOrNull(LauncherSurfacesStore.KEY_NEW_AGENT_LABEL),
        needsInputUrl = payload.stringOrNull(LauncherSurfacesStore.KEY_NEEDS_INPUT_URL),
        needsInputLabel = payload.stringOrNull(LauncherSurfacesStore.KEY_NEEDS_INPUT_LABEL),
        openLastSessionUrl = payload.stringOrNull(LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_URL),
        openLastSessionLabel = payload.stringOrNull(LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_LABEL),
      )

    val editor =
      LauncherSurfacesStore.prefs(context)
        .edit()
        .putOrRemove(LauncherSurfacesStore.KEY_NEW_AGENT_URL, surfaces.newAgentUrl)
        .putOrRemove(LauncherSurfacesStore.KEY_NEW_AGENT_LABEL, surfaces.newAgentLabel)
        .putOrRemove(LauncherSurfacesStore.KEY_NEEDS_INPUT_URL, surfaces.needsInputUrl)
        .putOrRemove(LauncherSurfacesStore.KEY_NEEDS_INPUT_LABEL, surfaces.needsInputLabel)
        .putOrRemove(LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_URL, surfaces.openLastSessionUrl)
        .putOrRemove(LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_LABEL, surfaces.openLastSessionLabel)
    check(editor.commit()) { "Cannot cache the launcher surfaces payload" }

    pinDynamicShortcuts(surfaces)
    requestTileRefresh()
  }

  /** Called by JS after sign-out: keep only the New agent action. */
  private fun clearDynamicSurfaces() {
    val editor =
      LauncherSurfacesStore.prefs(context)
        .edit()
        .remove(LauncherSurfacesStore.KEY_NEEDS_INPUT_URL)
        .remove(LauncherSurfacesStore.KEY_NEEDS_INPUT_LABEL)
        .remove(LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_URL)
        .remove(LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_LABEL)
    check(editor.commit()) { "Cannot clear the launcher surfaces payload" }

    pinDynamicShortcuts(LauncherSurfacesStore.read(context))
    requestTileRefresh()
  }

  private fun pinDynamicShortcuts(surfaces: CachedSurfaces) {
    if (Build.VERSION.SDK_INT < 25) {
      return
    }
    val shortcuts = mutableListOf<ShortcutInfo>()
    surfaces.newAgentUrl?.let {
      shortcuts += shortcut(SHORTCUT_NEW_AGENT, surfaces.newAgentLabel, it)
    }
    surfaces.needsInputUrl?.let {
      shortcuts += shortcut(SHORTCUT_NEEDS_INPUT, surfaces.needsInputLabel, it)
    }
    surfaces.openLastSessionUrl?.let {
      shortcuts += shortcut(SHORTCUT_OPEN_LAST_SESSION, surfaces.openLastSessionLabel, it)
    }
    shortcutManager().setDynamicShortcuts(shortcuts)
  }

  private fun shortcut(id: String, label: String?, url: String): ShortcutInfo {
    val builder =
      ShortcutInfo.Builder(context, id)
        .setShortLabel(label ?: id)
        .setLongLabel(label ?: id)
        .setIcon(Icon.createWithResource(context, R.drawable.kilo_launcher_surfaces_shortcut))
        .setIntent(actionIntent(context, url))
    // setLongLived(boolean) is API 29: unguarded it throws NoSuchMethodError on an
    // API 25-28 device and the whole shortcut publish (and the tile refresh) is lost.
    if (Build.VERSION.SDK_INT >= 29) {
      builder.setLongLived(true)
    }
    return builder.build()
  }

  private fun shortcutManager(): ShortcutManager =
    context.getSystemService(Context.SHORTCUT_SERVICE) as ShortcutManager

  private fun requestTileRefresh() {
    TileService.requestListeningState(
      context,
      ComponentName(context, QuickSettingsTileService::class.java),
    )
  }

  private companion object {
    const val SHORTCUT_NEW_AGENT = "new-agent"
    const val SHORTCUT_NEEDS_INPUT = "needs-input"
    const val SHORTCUT_OPEN_LAST_SESSION = "open-last-session"
  }
}
