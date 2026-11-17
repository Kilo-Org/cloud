package com.kilocode.homewidgetrefresh

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.work.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object HomeWidgetStore {
  private const val ALIAS = "kilo-home-widget-context"
  private const val WORK = "kilo-home-widget-refresh"
  private const val DEFAULT_REFRESH_MS = 1_800_000L
  private const val MIN_REFRESH_DELAY_MS = 900_000L
  private fun prefs(context: Context) = context.getSharedPreferences("home-widget-refresh", Context.MODE_PRIVATE)
  /** The one cadence clamp: a refresh instant becomes a delay of at least the minimum. */
  private fun delayFrom(refreshAt: Long, now: Long): Long = (refreshAt - now).coerceAtLeast(MIN_REFRESH_DELAY_MS)
  /** Every write that supersedes the stored payload rotates the fence `current` checks. */
  private fun SharedPreferences.Editor.rotateGeneration(): SharedPreferences.Editor = putString("generation", UUID.randomUUID().toString())
  /** A missing key and a JSON null are both "no value"; `optString` would return the literal "null". */
  private fun JSONObject.text(key: String): String? = if (isNull(key)) null else optString(key, null)
  private fun JSONObject.number(key: String): Long? = if (isNull(key)) null else getLong(key)
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  @Synchronized fun config(context: Context): JSONObject? {
    val encrypted = prefs(context).getString("protectedContext", null) ?: return null
    return try {
      val bytes = Base64.decode(encrypted, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
    } catch (_: Exception) { null }
  }
  @Synchronized fun configure(context: Context, config: JSONObject) {
    val previous = HomeWidgetStore.config(context)
    if (previous != null && (previous.text("scopeKey") != config.text("scopeKey") || previous.number("accountEpoch") != config.number("accountEpoch"))) clear(context)
    val refreshAt = config.number("refreshAt") ?: (System.currentTimeMillis() + DEFAULT_REFRESH_MS)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.iv + cipher.doFinal(config.toString().toByteArray(Charsets.UTF_8))
    check(prefs(context).edit().putString("protectedContext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
      .rotateGeneration().putString("data", config.getJSONObject("data").toString())
      .remove("terminalFence").putLong("refreshAt", refreshAt)
      .putLong("refreshDelay", delayFrom(refreshAt, System.currentTimeMillis())).commit())
    schedule(context, replace = true)
  }
  @Synchronized fun clear(context: Context, cancel: Boolean = true) {
    prefs(context).edit().remove("protectedContext").remove("data").remove("terminalFence")
      .remove("refreshAt").remove("refreshDelay").rotateGeneration().commit()
    if (cancel) WorkManager.getInstance(context).cancelUniqueWork(WORK)
  }
  @Synchronized fun fixture(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean("fixture", enabled).rotateGeneration().commit()
    if (enabled) WorkManager.getInstance(context).cancelUniqueWork(WORK) else schedule(context, replace = true)
  }
  fun hasWidgets(context: Context): Boolean = AppWidgetManager.getInstance(context)
    .getAppWidgetIds(ComponentName(context.packageName, "${context.packageName}.widget.ActiveAgentsWidget")).isNotEmpty()
  @Synchronized fun generation(context: Context) = prefs(context).getString("generation", "")!!
  @Synchronized fun current(context: Context, scope: String, epoch: Long, generation: String): Boolean {
    if (!hasWidgets(context) || prefs(context).getBoolean("fixture", false) || generation(context) != generation) return false
    val config = config(context) ?: prefs(context).getString("terminalFence", null)?.let { JSONObject(it) } ?: return false
    return config.text("scopeKey") == scope && config.number("accountEpoch") == epoch
  }
  @Synchronized fun data(context: Context): JSONObject? = prefs(context).getString("data", null)?.let { JSONObject(it) }
  @Synchronized fun schedule(context: Context, replace: Boolean = false) {
    if (config(context) == null || !hasWidgets(context) || prefs(context).getBoolean("fixture", false)) {
      WorkManager.getInstance(context).cancelUniqueWork(WORK)
      return
    }
    val now = System.currentTimeMillis()
    val wake = prefs(context).getLong("refreshAt", now + DEFAULT_REFRESH_MS)
    val requestedAt = if (wake > now) wake else now + prefs(context).getLong("refreshDelay", DEFAULT_REFRESH_MS)
    val delay = delayFrom(requestedAt, now)
    val request = OneTimeWorkRequest.Builder(HomeWidgetRefreshWorker::class.java)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setInitialDelay(delay, TimeUnit.MILLISECONDS).build()
    WorkManager.getInstance(context).enqueueUniqueWork(WORK,
      if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE, request)
  }
  fun fetch(context: Context): JSONObject? {
    val config: JSONObject
    val generation: String
    synchronized(this) {
      if (!hasWidgets(context) || prefs(context).getBoolean("fixture", false)) return null
      config = config(context) ?: return null
      generation = generation(context)
    }
    val endpoint = config.text("endpoint")?.let { URL(it) } ?: return null
    require(endpoint.protocol == "https" || endpoint.host == "localhost" || endpoint.host == "127.0.0.1" || endpoint.host == "10.0.2.2")
    val token = config.text("token") ?: return null
    val scopeKey = config.text("scopeKey") ?: return null
    val accountEpoch = config.number("accountEpoch") ?: return null
    val connection = endpoint.openConnection() as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 15_000
    connection.instanceFollowRedirects = false
    connection.setRequestProperty("Authorization", "Bearer $token")
    connection.setRequestProperty("Accept", "application/json")
    try {
      val status = connection.responseCode
      // Only an authentication refusal is terminal; 403 and every other failure keep retained content.
      if (status == 401) {
        synchronized(this) {
          if (!current(context, scopeKey, accountEpoch, generation)) return null
          clear(context, cancel = false)
          val fence = JSONObject().put("scopeKey", scopeKey)
            .put("accountEpoch", accountEpoch).put("generation", generation(context))
          prefs(context).edit().putString("terminalFence", fence.toString()).commit()
          return fence.put("terminal", "privacy")
        }
      }
      if (status != 200) return null
      val bytes = connection.inputStream.use { stream ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (output.size() <= 262_144) {
          val count = stream.read(buffer, 0, minOf(buffer.size, 262_145 - output.size()))
          if (count < 0) break
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
      if (bytes.size > 262_144) return null
      val response = JSONObject(String(bytes, Charsets.UTF_8))
      val snapshot = response.getJSONObject("snapshot")
      if (snapshot.text("scopeKey") != scopeKey) return null
      response.getJSONObject("home")
      val data = JSONObject().put("snapshot", snapshot).put("details", response.getJSONObject("details"))
      synchronized(this) {
        if (!current(context, scopeKey, accountEpoch, generation)) return null
        val previousAt = HomeWidgetStore.data(context)?.getJSONObject("snapshot")?.text("updatedAt")
        val nextAt = snapshot.text("updatedAt") ?: return null
        if (previousAt != null && nextAt < previousAt) return null
        prefs(context).edit().putString("data", data.toString()).putLong("refreshAt", response.getLong("refreshAt"))
          .putLong("refreshDelay", delayFrom(response.getLong("refreshAt"), System.currentTimeMillis())).commit()
      }
      return JSONObject().put("response", response).put("scopeKey", scopeKey)
        .put("accountEpoch", accountEpoch).put("generation", generation)
        .put("copy", config.optJSONObject("copy") ?: JSONObject()).put("locale", config.text("locale") ?: "")
    } finally { connection.disconnect() }
  }
}
