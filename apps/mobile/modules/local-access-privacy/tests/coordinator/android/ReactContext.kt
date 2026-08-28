package com.facebook.react.bridge

import android.app.Activity
import android.content.Context
import com.facebook.react.interfaces.ExtraWindowEventListener

class ReactContext(val currentActivity: Activity?) : Context() {
  val listeners = mutableListOf<ExtraWindowEventListener>()
  fun addExtraWindowEventListener(listener: ExtraWindowEventListener) { listeners.add(listener) }
  fun removeExtraWindowEventListener(listener: ExtraWindowEventListener) { listeners.remove(listener) }
}
