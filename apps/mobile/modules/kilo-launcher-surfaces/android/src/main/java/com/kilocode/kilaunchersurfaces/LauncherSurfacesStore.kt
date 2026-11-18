package com.kilocode.kilaunchersurfaces

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONObject

/**
 * One action a launcher surface offers: the destination and the copy that names it.
 *
 * The url and its label are one unit because the surface is one tap. A label
 * without its url names an action nothing opens, and a url without its label
 * shows copy the payload never wrote; a null action is an action that is absent.
 */
internal data class SurfaceAction(val url: String, val label: String)

/**
 * The launcher surfaces payload frozen by the JS side.
 *
 * [newAgent] is required: JS always publishes it, and
 * [KiloLauncherSurfacesModule] rejects a payload without it before the cache is
 * touched. The other two actions are dynamic: a null action is absent and must
 * be neither pinned nor offered.
 */
internal data class CachedSurfaces(
  val newAgent: SurfaceAction,
  val needsInput: SurfaceAction?,
  val openLastSession: SurfaceAction?,
) {
  /**
   * The quick-settings tile's one decision: Needs input while an agent waits,
   * otherwise New agent. The tile label and the tap both read this value, so
   * the tile cannot name one action and open another.
   */
  val tileAction: SurfaceAction get() = needsInput ?: newAgent
}

/**
 * SharedPreferences store shared by the Expo module and [QuickSettingsTileService].
 *
 * Writes commit synchronously: the tile reads this payload from a cold process the
 * moment the user taps, so the value has to be on disk before `setSurfaces` returns.
 */
internal object LauncherSurfacesStore {
  const val PREFS_NAME = "launcher_surfaces"

  const val KEY_NEW_AGENT_URL = "newAgentUrl"
  const val KEY_NEW_AGENT_LABEL = "newAgentLabel"
  const val KEY_NEEDS_INPUT_URL = "needsInputUrl"
  const val KEY_NEEDS_INPUT_LABEL = "needsInputLabel"
  const val KEY_OPEN_LAST_SESSION_URL = "openLastSessionUrl"
  const val KEY_OPEN_LAST_SESSION_LABEL = "openLastSessionLabel"

  fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /**
   * The cached surfaces, or null when no usable payload was ever published. A
   * caller with nothing cached shows its static label and opens the app itself.
   */
  fun read(context: Context): CachedSurfaces? {
    val prefs = prefs(context)
    return CachedSurfaces(
      newAgent = prefs.action(KEY_NEW_AGENT_URL, KEY_NEW_AGENT_LABEL) ?: return null,
      needsInput = prefs.action(KEY_NEEDS_INPUT_URL, KEY_NEEDS_INPUT_LABEL),
      openLastSession = prefs.action(KEY_OPEN_LAST_SESSION_URL, KEY_OPEN_LAST_SESSION_LABEL),
    )
  }
}

/** A `kiloapp`-scheme view intent that only this app can resolve. */
internal fun actionIntent(context: Context, url: String): Intent =
  Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(context.packageName)

/**
 * Stores [action], or drops both of its keys when it is absent, so an action the
 * payload leaves out disappears from the launcher and the tile.
 */
internal fun SharedPreferences.Editor.putAction(
  urlKey: String,
  labelKey: String,
  action: SurfaceAction?,
): SharedPreferences.Editor =
  if (action == null) {
    remove(urlKey).remove(labelKey)
  } else {
    putString(urlKey, action.url).putString(labelKey, action.label)
  }

/** Reads one cached action: both halves or nothing. */
private fun SharedPreferences.action(urlKey: String, labelKey: String): SurfaceAction? {
  val url = stringOrNull(urlKey) ?: return null
  return SurfaceAction(url, stringOrNull(labelKey) ?: return null)
}

private fun SharedPreferences.stringOrNull(key: String): String? =
  getString(key, null)?.takeIf { it.isNotEmpty() }

/** Reads one action from a payload: both halves or nothing. */
internal fun JSONObject.action(urlKey: String, labelKey: String): SurfaceAction? {
  val url = stringOrNull(urlKey) ?: return null
  return SurfaceAction(url, stringOrNull(labelKey) ?: return null)
}

/** Reads a payload string, treating an explicit JSON null or an absent key as null. */
internal fun JSONObject.stringOrNull(key: String): String? =
  if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
