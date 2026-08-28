package android.view

// Coordinator inputs only. WindowId models the native owner; focus models delivered View callbacks.
open class View {
  var isAttachedToWindow = true
  var windowId: WindowId? = WindowId()
  var focus = false
  var onChange: (() -> Unit)? = null
  var onDetach: (() -> Unit)? = null
  var acceptsPosts = true
  private val posts = mutableListOf<() -> Unit>()
  fun post(action: () -> Unit): Boolean {
    if (!acceptsPosts) return false
    // Only an attached View has the UI Handler used by the removal checkpoint.
    if (isAttachedToWindow) posts.add(action)
    return true
  }
  fun dispatchPostedActions() {
    val pending = posts.toList()
    posts.clear()
    pending.forEach { it() }
  }
  fun detach() {
    // View dispatches the listener before clearing AttachInfo; WindowManager removal follows later.
    onDetach?.invoke()
    isAttachedToWindow = false
    windowId = null
  }
  fun hasWindowFocus() = focus
  fun dispatchWindowFocus(value: Boolean) {
    focus = value
    onChange?.invoke()
  }
}

open class ViewGroup : View() {
  val children = mutableListOf<View>()
  val childCount get() = children.size
  fun getChildAt(index: Int) = children[index]
}

class WindowId(var isFocused: Boolean = false) {
  abstract class FocusObserver {
    abstract fun onFocusGained(token: WindowId?)
    abstract fun onFocusLost(token: WindowId?)
  }
  val observers = mutableSetOf<FocusObserver>()
  fun registerFocusObserver(observer: FocusObserver) { check(observers.add(observer)) }
  fun unregisterFocusObserver(observer: FocusObserver) { check(observers.remove(observer)) }
  fun dispatchFocusChange() {
    observers.toList().forEach {
      if (isFocused) it.onFocusGained(this) else it.onFocusLost(this)
    }
  }
}

class Window {
  val decorView = ViewGroup()
  var covered = false
  var gateVisible = false
  var inputFocused = true
  var focusClears = 0
}
