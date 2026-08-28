package expo.modules.localaccessprivacy

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.lang.ref.WeakReference

internal class ApplicationWindowCover(
  val window: Window,
  val activity: Activity?,
  private val activityWindow: Boolean,
  private val onChange: () -> Unit,
  private val onDetach: () -> Unit
) {
  private val decor = window.decorView as ViewGroup
  private val opacity = FrameLayout(decor.context).apply {
    setBackgroundColor(Color.BLACK)
    isClickable = true
    isFocusableInTouchMode = true
  }
  private val previousAccessibility = mutableMapOf<View, Int>()
  private val wasSecure = window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
  private val previousCallback = requireNotNull(window.callback)
  private var covered = false
  private var savedFocus: WeakReference<View>? = null
  private var savedTitle: CharSequence? = null
  private var savedAccessibilityTitle: CharSequence? = null
  private var renderedGeneration = -1L
  private var renderedGate: PrivacyGate? = null

  private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener {
    onChange()
  }
  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    // Modal recreation can replace a decor between JS events. Never traverse uncovered content.
    onChange()
    if (covered) {
      suppressContent()
      if (opacity.parent !== decor) return@OnPreDrawListener false
      opacity.measure(
        View.MeasureSpec.makeMeasureSpec(decor.width, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(decor.height, View.MeasureSpec.EXACTLY))
      opacity.layout(0, 0, decor.width, decor.height)
    }
    true
  }
  private val attachment = object : View.OnAttachStateChangeListener {
    override fun onViewAttachedToWindow(view: View) { onChange() }
    override fun onViewDetachedFromWindow(view: View) { onDetach() }
  }
  private val guardedCallback = object : Window.Callback by previousCallback {
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
      if (!covered) return previousCallback.dispatchKeyEvent(event)
      if (event.action == KeyEvent.ACTION_DOWN) {
        val direction = when (event.keyCode) {
          KeyEvent.KEYCODE_TAB -> if (event.isShiftPressed) View.FOCUS_BACKWARD else View.FOCUS_FORWARD
          KeyEvent.KEYCODE_DPAD_DOWN -> View.FOCUS_DOWN
          KeyEvent.KEYCODE_DPAD_UP -> View.FOCUS_UP
          KeyEvent.KEYCODE_DPAD_LEFT -> View.FOCUS_LEFT
          KeyEvent.KEYCODE_DPAD_RIGHT -> View.FOCUS_RIGHT
          else -> null
        }
        if (direction != null) {
          val finder = android.view.FocusFinder.getInstance()
          val next = finder.findNextFocus(opacity, opacity.findFocus(), direction)
            ?: finder.findNextFocus(opacity, null, direction)
          next?.requestFocus()
          return true
        }
      }
      opacity.dispatchKeyEvent(event)
      return true
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean =
      if (covered) opacity.dispatchGenericMotionEvent(event) else previousCallback.dispatchGenericMotionEvent(event)

    override fun dispatchPopulateAccessibilityEvent(event: AccessibilityEvent): Boolean {
      if (!covered) return previousCallback.dispatchPopulateAccessibilityEvent(event)
      event.text.clear()
      event.contentDescription = null
      return true
    }
  }

  init {
    decor.viewTreeObserver.addOnWindowFocusChangeListener(focusListener)
    decor.viewTreeObserver.addOnPreDrawListener(preDraw)
    decor.addOnAttachStateChangeListener(attachment)
    window.callback = guardedCallback
  }

  fun hasFocus(): Boolean = decor.hasWindowFocus() && decor.isAttachedToWindow

  fun resetGate() { renderedGeneration = -1 }

  fun apply(armed: Boolean, hide: Boolean, gate: PrivacyGate?, generation: Long, onAction: (Long, String) -> Unit) {
    val secure = window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
    if (armed && !secure) {
      // Expo supplies the initial Activity flag. Retain it on recreated Activities and all dialogs.
      window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } else if (!armed && !activityWindow && !wasSecure && secure) {
      window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    if (hide) {
      if (!covered) {
        savedFocus = decor.findFocus()?.let { WeakReference(it) }
        savedTitle = window.attributes.title
        if (Build.VERSION.SDK_INT >= 26) savedAccessibilityTitle = window.attributes.accessibilityTitle
        // Hide the IME, not the draft. Restore its application focus only after access publication.
        val keyboard = decor.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        keyboard.hideSoftInputFromWindow(decor.windowToken, 0)
        decor.findFocus()?.clearFocus()
      }
      covered = true
      if (window.attributes.title.isNotEmpty()) window.setTitle("")
      if (Build.VERSION.SDK_INT >= 26 && window.attributes.accessibilityTitle != "") {
        val attributes = window.attributes
        attributes.accessibilityTitle = ""
        window.attributes = attributes
      }
      suppressContent()
      if (opacity.parent == null) decor.addView(opacity, ViewGroup.LayoutParams(-1, -1))
      opacity.importantForAccessibility = if (gate == null) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
      renderGate(gate, generation, onAction)
    } else if (covered) {
      covered = false
      decor.removeView(opacity)
      restoreAccessibility()
      savedTitle?.let { window.setTitle(it) }
      if (Build.VERSION.SDK_INT >= 26) {
        val attributes = window.attributes
        attributes.accessibilityTitle = savedAccessibilityTitle
        window.attributes = attributes
      }
      renderedGate = null
      renderedGeneration = -1
    }
  }

  private fun suppressContent() {
    var elevation = 0f
    for (index in 0 until decor.childCount) {
      val child = decor.getChildAt(index)
      if (child === opacity) continue
      previousAccessibility.putIfAbsent(child, child.importantForAccessibility)
      child.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      elevation = maxOf(elevation, child.elevation)
    }
    opacity.elevation = elevation + 1f
    if (opacity.parent === decor && decor.getChildAt(decor.childCount - 1) !== opacity) opacity.bringToFront()
  }

  private fun restoreAccessibility() {
    previousAccessibility.forEach { (view, previous) -> view.importantForAccessibility = previous }
    previousAccessibility.clear()
  }

  private fun renderGate(gate: PrivacyGate?, generation: Long, onAction: (Long, String) -> Unit) {
    if (renderedGeneration == generation && renderedGate === gate) return
    opacity.removeAllViews()
    renderedGeneration = generation
    renderedGate = gate
    if (gate == null) return
    val scroll = ScrollView(decor.context)
    val stack = LinearLayout(decor.context).apply {
      orientation = LinearLayout.VERTICAL
      val padding = (24 * resources.displayMetrics.density).toInt()
      setPadding(padding, padding, padding, padding)
    }
    for (text in listOf(gate.title, gate.message)) {
      stack.addView(TextView(decor.context).apply {
        this.text = text
        setTextColor(Color.WHITE)
        textSize = 20f
      })
    }
    for (action in gate.actions) {
      stack.addView(Button(decor.context).apply {
        text = action.label
        isEnabled = action.enabled
        minHeight = (48 * resources.displayMetrics.density).toInt()
        setOnClickListener { onAction(generation, action.id) }
      })
    }
    scroll.addView(stack)
    opacity.addView(scroll, FrameLayout.LayoutParams(-1, -1))
    if (hasFocus()) {
      stack.getChildAt(0)?.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED)
      if (stack.getFocusables(View.FOCUS_FORWARD).firstOrNull { it.isEnabled }?.requestFocus() != true) {
        opacity.requestFocus()
      }
    }
  }

  fun restoreFocus() {
    if (covered || !hasFocus()) return
    val target = savedFocus?.get()
    if (target?.isAttachedToWindow == true && target.isShown) {
      target.requestFocus()
      target.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED)
    } else {
      decor.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
    }
    savedFocus = null
  }

  fun dispose() {
    if (decor.viewTreeObserver.isAlive) {
      decor.viewTreeObserver.removeOnPreDrawListener(preDraw)
      decor.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
    }
    decor.removeOnAttachStateChangeListener(attachment)
    decor.removeView(opacity)
    restoreAccessibility()
    if (covered) {
      savedTitle?.let { window.setTitle(it) }
      if (Build.VERSION.SDK_INT >= 26) {
        val attributes = window.attributes
        attributes.accessibilityTitle = savedAccessibilityTitle
        window.attributes = attributes
      }
      covered = false
    }
    if (window.callback === guardedCallback) window.callback = previousCallback
    if (!activityWindow && !wasSecure) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }
}
