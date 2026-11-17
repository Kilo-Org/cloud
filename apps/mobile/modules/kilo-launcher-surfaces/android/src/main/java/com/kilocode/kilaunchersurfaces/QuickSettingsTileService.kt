package com.kilocode.kilaunchersurfaces

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick-settings tile for the Kilo launcher surface.
 *
 * The tile is not a plain launcher: [onClick] opens the url of the cached
 * [CachedSurfaces.tileAction] and [applyCachedSurfaces] labels the tile from the
 * same value, so the tile says what it will open. Only when nothing has ever been
 * published does the tile fall back to the static label and the app's launcher
 * intent.
 *
 * `setSurfaces` / `clearDynamicSurfaces` request a listening refresh, so a publish
 * updates a placed tile without the app being open.
 */
class QuickSettingsTileService : TileService() {
  /**
   * A tile the user just placed is rendered from this service's manifest
   * metadata — the fallback label and `STATE_UNAVAILABLE` — and the panel that
   * added it does not always call [onStartListening] again, so a tile added
   * while an agent waits read the fallback until the next publish. The service
   * is bound for the placed tile, so publish the cached payload here too.
   */
  override fun onTileAdded() {
    super.onTileAdded()
    applyCachedSurfaces()
  }

  override fun onStartListening() {
    super.onStartListening()
    applyCachedSurfaces()
  }

  /** Push the cached payload into the tile the service is currently bound to. */
  private fun applyCachedSurfaces() {
    val tile = qsTile ?: return
    tile.label =
      LauncherSurfacesStore.read(this)?.tileAction?.label
        ?: getString(R.string.kilo_launcher_surfaces_tile_label)
    tile.state = Tile.STATE_ACTIVE
    tile.updateTile()
  }

  override fun onClick() {
    super.onClick()
    val url = LauncherSurfacesStore.read(this)?.tileAction?.url
    val intent =
      if (url != null) {
        actionIntent(this, url)
      } else {
        packageManager.getLaunchIntentForPackage(packageName)
      }
    if (intent == null) {
      // Nothing was ever published and the app has no launcher activity. Do not
      // surface an error from the tile.
      return
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (Build.VERSION.SDK_INT >= 26) {
      unlockAndRun { startSurface(intent) }
    } else {
      startSurface(intent)
    }
  }

  private fun startSurface(intent: Intent) {
    if (Build.VERSION.SDK_INT >= 34) {
      startActivityAndCollapse(
        PendingIntent.getActivity(
          this,
          TILE_REQUEST_CODE,
          intent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    } else {
      startActivity(intent)
    }
  }

  private companion object {
    const val TILE_REQUEST_CODE = 2001
  }
}
