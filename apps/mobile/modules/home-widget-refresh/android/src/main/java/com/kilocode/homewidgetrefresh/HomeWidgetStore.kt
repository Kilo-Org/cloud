package com.kilocode.homewidgetrefresh

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
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
  private fun prefs(context: Context) = context.getSharedPreferences("home-widget-refresh", Context.MODE_PRIVATE)
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
    if (previous != null && (previous.optString("scopeKey") != config.optString("scopeKey") || previous.optInt("accountEpoch") != config.optInt("accountEpoch"))) clear(context)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.iv + cipher.doFinal(config.toString().toByteArray(Charsets.UTF_8))
    check(prefs(context).edit().putString("protectedContext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
      .putString("generation", UUID.randomUUID().toString()).putString("data", config.getJSONObject("data").toString())
      .remove("terminalFence").putLong("refreshAt", config.getLong("refreshAt"))
      .putLong("refreshDelay", (config.getLong("refreshAt") - System.currentTimeMillis()).coerceAtLeast(900_000)).commit())
    schedule(context, replace = true)
  }
  @Synchronized fun clear(context: Context, cancel: Boolean = true) {
    prefs(context).edit().remove("protectedContext").remove("data").remove("terminalFence")
      .remove("refreshAt").remove("refreshDelay").putString("generation", UUID.randomUUID().toString()).commit()
    if (cancel) WorkManager.getInstance(context).cancelUniqueWork(WORK)
  }
  @Synchronized fun fixture(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean("fixture", enabled).putString("generation", UUID.randomUUID().toString()).commit()
    if (enabled) WorkManager.getInstance(context).cancelUniqueWork(WORK) else schedule(context, replace = true)
  }
  fun hasWidgets(context: Context): Boolean = AppWidgetManager.getInstance(context)
    .getAppWidgetIds(ComponentName(context.packageName, "${context.packageName}.widget.ActiveAgentsWidget")).isNotEmpty()
  @Synchronized fun generation(context: Context) = prefs(context).getString("generation", "")!!
  @Synchronized fun current(context: Context, scope: String, epoch: Int, generation: String): Boolean {
    if (!hasWidgets(context) || prefs(context).getBoolean("fixture", false) || generation(context) != generation) return false
    val config = config(context) ?: prefs(context).getString("terminalFence", null)?.let { JSONObject(it) } ?: return false
    return config.optString("scopeKey") == scope && config.optInt("accountEpoch") == epoch
  }
  @Synchronized fun data(context: Context): JSONObject? = prefs(context).getString("data", null)?.let { JSONObject(it) }
  @Synchronized fun schedule(context: Context, replace: Boolean = false) {
    if (config(context) == null || !hasWidgets(context) || prefs(context).getBoolean("fixture", false)) {
      WorkManager.getInstance(context).cancelUniqueWork(WORK)
      return
    }
    val now = System.currentTimeMillis()
    val wake = prefs(context).getLong("refreshAt", now + 1_800_000)
    val requested = if (wake > now) wake - now else prefs(context).getLong("refreshDelay", 1_800_000)
    val delay = requested.coerceAtLeast(900_000)
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
    val endpoint = URL(config.getString("endpoint"))
    require(endpoint.protocol == "https" || endpoint.host == "localhost" || endpoint.host == "127.0.0.1" || endpoint.host == "10.0.2.2")
    val connection = endpoint.openConnection() as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 15_000
    connection.instanceFollowRedirects = false
    connection.setRequestProperty("Authorization", "Bearer ${config.getString("token")}")
    connection.setRequestProperty("Accept", "application/json")
    try {
      val status = connection.responseCode
      // Only an authentication refusal is terminal; 403 and every other failure keep retained content.
      if (status == 401) {
        synchronized(this) {
          if (!current(context, config.getString("scopeKey"), config.getInt("accountEpoch"), generation)) return null
          clear(context, cancel = false)
          val fence = JSONObject().put("scopeKey", config.getString("scopeKey"))
            .put("accountEpoch", config.getInt("accountEpoch")).put("generation", generation(context))
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
      if (snapshot.getString("scopeKey") != config.getString("scopeKey")) return null
      response.getJSONObject("home")
      val data = JSONObject().put("snapshot", snapshot).put("details", response.getJSONObject("details"))
      synchronized(this) {
        if (!current(context, config.getString("scopeKey"), config.getInt("accountEpoch"), generation)) return null
        val oldAt = HomeWidgetStore.data(context)?.getJSONObject("snapshot")?.optString("updatedAt")
        if (oldAt != null && snapshot.getString("updatedAt") < oldAt) return null
        prefs(context).edit().putString("data", data.toString()).putLong("refreshAt", response.getLong("refreshAt"))
          .putLong("refreshDelay", (response.getLong("refreshAt") - System.currentTimeMillis()).coerceAtLeast(900_000)).commit()
      }
      return JSONObject().put("response", response).put("scopeKey", config.getString("scopeKey"))
        .put("accountEpoch", config.getInt("accountEpoch")).put("generation", generation)
        .put("copy", config.getJSONObject("copy")).put("locale", config.getString("locale"))
    } finally { connection.disconnect() }
  }
}
