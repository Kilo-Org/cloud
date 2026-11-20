package com.kilocode.homewidgetrefresh

import org.json.JSONObject
import org.json.JSONArray

/** Converts a stored JSON payload into the map React Native's bridge accepts. */
internal fun jsonValue(value: Any?): Any? = when (value) {
  JSONObject.NULL -> null
  is JSONObject -> jsonMap(value)
  is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
  else -> value
}
internal fun jsonMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
