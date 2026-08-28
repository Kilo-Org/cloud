package android.content

import android.view.accessibility.AccessibilityManager

open class Context {
  companion object { const val ACCESSIBILITY_SERVICE = "accessibility" }
  val packageName = "privacy.coordinator.test"
  fun getSystemService(name: String): Any {
    check(name == ACCESSIBILITY_SERVICE)
    return AccessibilityManager()
  }
}
