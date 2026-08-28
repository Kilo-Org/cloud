package expo.modules.localaccessprivacy

import android.app.Activity
import android.view.Window

// Observe coordinator outputs without claiming to render Android windows or a keyboard.
internal class ApplicationWindowCover(
  val window: Window,
  val activity: Activity?,
  activityWindow: Boolean,
  onChange: () -> Unit,
  onDetach: () -> Unit
) {
  init {
    window.decorView.onChange = onChange
    window.decorView.onDetach = onDetach
  }
  fun hasFocus() = window.decorView.hasWindowFocus() && window.decorView.isAttachedToWindow
  fun resetGate() = Unit
  fun apply(armed: Boolean, hide: Boolean, gate: PrivacyGate?, generation: Long, onAction: (Long, String) -> Unit) {
    if (hide && !window.covered) {
      window.inputFocused = false
      window.focusClears += 1
    }
    window.covered = hide
    window.gateVisible = hide && gate != null
  }
  fun restoreFocus() { window.inputFocused = true }
  fun dispose() {
    window.decorView.onChange = null
    window.decorView.onDetach = null
    window.covered = false
  }
}

class PrivacyGateAction(val id: String, val enabled: Boolean = true)
class PrivacyGate(val actions: List<PrivacyGateAction> = emptyList())
class LocalAccessPrivacyModule
