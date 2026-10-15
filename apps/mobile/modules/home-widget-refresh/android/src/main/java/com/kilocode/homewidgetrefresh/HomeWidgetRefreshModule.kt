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
  override fun definition() = ModuleDefinition {
    Name("HomeWidgetRefresh")
    Function("getOperationEpoch") { synchronized(operationLock) { operationEpoch.toDouble() } }
    AsyncFunction("configure") { payload: String ->
      val json = JSONObject(payload)
      val epoch = json.getLong("operationEpoch")
      synchronized(operationLock) {
        if (!destroyed && epoch > operationEpoch) {
          operationEpoch = epoch
          HomeWidgetStore.configure(context, json)
        }
      }
    }
    AsyncFunction("clear") { epoch: Long ->
      synchronized(operationLock) {
        if (!destroyed && epoch > operationEpoch) {
          operationEpoch = epoch
          HomeWidgetStore.clear(context)
        }
      }
    }
    AsyncFunction("setFixtureMode") { enabled: Boolean -> HomeWidgetStore.fixture(context, enabled) }
    AsyncFunction("getData") { HomeWidgetStore.data(context)?.let { jsonMap(it) } }
    AsyncFunction("getWidgetPushToken") { null as String? }
    AsyncFunction("widgetsChanged") { HomeWidgetStore.schedule(context, replace = true) }
    AsyncFunction("isCurrent") { scope: String, epoch: Int, generation: String -> HomeWidgetStore.current(context, scope, epoch, generation) }
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
