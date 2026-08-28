package android.view.accessibility

class AccessibilityEvent {
  companion object {
    const val TYPE_ANNOUNCEMENT = 1
    fun obtain(type: Int): AccessibilityEvent {
      check(type == TYPE_ANNOUNCEMENT)
      return AccessibilityEvent()
    }
  }
  var packageName = ""
  var className = ""
  val text = mutableListOf<String>()
}
class AccessibilityManager {
  val isEnabled = true
  fun sendAccessibilityEvent(event: AccessibilityEvent) { check(event.text.isNotEmpty()) }
}
