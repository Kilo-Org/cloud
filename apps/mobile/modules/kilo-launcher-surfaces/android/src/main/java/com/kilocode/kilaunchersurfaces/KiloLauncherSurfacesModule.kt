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
 * the payload leaves out disappears from the launcher. The New agent action is
 * required, so a payload without it is rejected before the cache is touched.
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
    // The New agent action is the one action JS always publishes and the one the
    // sign-out clear keeps: reject a payload without it before anything is written.
    val surfaces =
      CachedSurfaces(
        newAgent =
          requireNotNull(
            payload.action(
              LauncherSurfacesStore.KEY_NEW_AGENT_URL,
              LauncherSurfacesStore.KEY_NEW_AGENT_LABEL,
            )
          ) {
            "The launcher surfaces payload must carry the New agent url and label"
          },
        needsInput =
          payload.action(
            LauncherSurfacesStore.KEY_NEEDS_INPUT_URL,
            LauncherSurfacesStore.KEY_NEEDS_INPUT_LABEL,
          ),
        openLastSession =
          payload.action(
            LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_URL,
            LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_LABEL,
          ),
      )

    val editor =
      LauncherSurfacesStore.prefs(context)
        .edit()
        .putAction(
          LauncherSurfacesStore.KEY_NEW_AGENT_URL,
          LauncherSurfacesStore.KEY_NEW_AGENT_LABEL,
          surfaces.newAgent,
        )
        .putAction(
          LauncherSurfacesStore.KEY_NEEDS_INPUT_URL,
          LauncherSurfacesStore.KEY_NEEDS_INPUT_LABEL,
          surfaces.needsInput,
        )
        .putAction(
          LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_URL,
          LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_LABEL,
          surfaces.openLastSession,
        )
    check(editor.commit()) { "Cannot cache the launcher surfaces payload" }

    pinDynamicShortcuts(surfaces)
    requestTileRefresh()
  }

  /** Called by JS after sign-out: keep only the New agent action. */
  private fun clearDynamicSurfaces() {
    val editor =
      LauncherSurfacesStore.prefs(context)
        .edit()
        .putAction(
          LauncherSurfacesStore.KEY_NEEDS_INPUT_URL,
          LauncherSurfacesStore.KEY_NEEDS_INPUT_LABEL,
          null,
        )
        .putAction(
          LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_URL,
          LauncherSurfacesStore.KEY_OPEN_LAST_SESSION_LABEL,
          null,
        )
    check(editor.commit()) { "Cannot clear the launcher surfaces payload" }

    pinDynamicShortcuts(LauncherSurfacesStore.read(context))
    requestTileRefresh()
  }

  private fun pinDynamicShortcuts(surfaces: CachedSurfaces?) {
    if (Build.VERSION.SDK_INT < 25) {
      return
    }
    val shortcuts = mutableListOf<ShortcutInfo>()
    if (surfaces != null) {
      shortcuts += shortcut(SHORTCUT_NEW_AGENT, surfaces.newAgent)
      surfaces.needsInput?.let { shortcuts += shortcut(SHORTCUT_NEEDS_INPUT, it) }
      surfaces.openLastSession?.let { shortcuts += shortcut(SHORTCUT_OPEN_LAST_SESSION, it) }
    }
    shortcutManager().setDynamicShortcuts(shortcuts)
  }

  private fun shortcut(id: String, action: SurfaceAction): ShortcutInfo {
    val builder =
      ShortcutInfo.Builder(context, id)
        .setShortLabel(action.label)
        .setLongLabel(action.label)
        .setIcon(Icon.createWithResource(context, R.drawable.kilo_launcher_surfaces_shortcut))
        .setIntent(actionIntent(context, action.url))
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
