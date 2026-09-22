package com.kilocode.kilaunchersurfaces

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONObject

/**
 * The launcher surfaces payload frozen by the JS side.
 *
 * `newAgentUrl` and `newAgentLabel` are always present. The other two actions are
 * dynamic: a null url means the action is absent and must not be pinned or offered.
 */
internal data class CachedSurfaces(
  val newAgentUrl: String?,
  val newAgentLabel: String?,
  val needsInputUrl: String?,
  val needsInputLabel: String?,
  val openLastSessionUrl: String?,
  val openLastSessionLabel: String?,
) {
  /** True when an agent waits for input, so the tile routes to Needs input. */
  val hasPendingInput: Boolean get() = !needsInputUrl.isNullOrEmpty()
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

  fun read(context: Context): CachedSurfaces {
    val prefs = prefs(context)
    return CachedSurfaces(
      newAgentUrl = prefs.stringOrNull(KEY_NEW_AGENT_URL),
      newAgentLabel = prefs.stringOrNull(KEY_NEW_AGENT_LABEL),
      needsInputUrl = prefs.stringOrNull(KEY_NEEDS_INPUT_URL),
      needsInputLabel = prefs.stringOrNull(KEY_NEEDS_INPUT_LABEL),
      openLastSessionUrl = prefs.stringOrNull(KEY_OPEN_LAST_SESSION_URL),
      openLastSessionLabel = prefs.stringOrNull(KEY_OPEN_LAST_SESSION_LABEL),
    )
  }
}

/** A `kiloapp`-scheme view intent that only this app can resolve. */
internal fun actionIntent(context: Context, url: String): Intent =
  Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(context.packageName)

/** Stores `value` when present and drops the key when absent, so stale actions disappear. */
internal fun SharedPreferences.Editor.putOrRemove(key: String, value: String?): SharedPreferences.Editor =
  if (value.isNullOrEmpty()) remove(key) else putString(key, value)

private fun SharedPreferences.stringOrNull(key: String): String? =
  getString(key, null)?.takeIf { it.isNotEmpty() }

/** Reads a payload string, treating an explicit JSON null or an absent key as null. */
internal fun JSONObject.stringOrNull(key: String): String? =
  if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
