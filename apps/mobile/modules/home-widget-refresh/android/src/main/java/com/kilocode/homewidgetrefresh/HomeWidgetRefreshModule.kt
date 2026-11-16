package com.kilocode.homewidgetrefresh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import org.json.JSONArray

class HomeWidgetRefreshModule : Module() {
  private val operationLock = Any()
  private var operationEpoch = 0L
  private var destroyed = false
  private val context get() = requireNotNull(appContext.reactContext)
  /**
   * The one fence against a stale JS operation: only a live module accepts an epoch above the one it already
   * applied, and it applies the mutation inside the same lock.
   */
  private fun mutate(epoch: Long, action: () -> Unit) {
    synchronized(operationLock) {
      if (!destroyed && epoch > operationEpoch) {
        operationEpoch = epoch
        action()
      }
    }
  }
  /** JS numbers cross the bridge as Double; every native path keeps the epoch as a Long. */
  private fun bridgeEpoch(epoch: Long): Double = epoch.toDouble()
  override fun definition() = ModuleDefinition {
    Name("HomeWidgetRefresh")
    Function("getOperationEpoch") { synchronized(operationLock) { bridgeEpoch(operationEpoch) } }
    AsyncFunction("configure") { payload: String ->
      val json = JSONObject(payload)
      mutate(json.getLong("operationEpoch")) { HomeWidgetStore.configure(context, json) }
    }
    AsyncFunction("clear") { epoch: Long -> mutate(epoch) { HomeWidgetStore.clear(context) } }
    AsyncFunction("setFixtureMode") { enabled: Boolean -> HomeWidgetStore.fixture(context, enabled) }
    AsyncFunction("getData") { HomeWidgetStore.data(context)?.let { jsonMap(it) } }
    AsyncFunction("getWidgetPushToken") { null as String? }
    AsyncFunction("widgetsChanged") { HomeWidgetStore.schedule(context, replace = true) }
    AsyncFunction("isCurrent") { scope: String, epoch: Long, generation: String -> HomeWidgetStore.current(context, scope, epoch, generation) }
    OnDestroy {
      synchronized(operationLock) {
        destroyed = true
        operationEpoch += 1
      }
    }
  }
}

internal fun jsonValue(value: Any?): Any? = when (value) {
  JSONObject.NULL -> null
  is JSONObject -> jsonMap(value)
  is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
  else -> value
}
internal fun jsonMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
