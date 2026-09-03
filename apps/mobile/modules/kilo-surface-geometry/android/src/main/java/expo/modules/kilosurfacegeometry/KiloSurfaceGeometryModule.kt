package expo.modules.kilosurfacegeometry

import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong

class KiloSurfaceGeometryModule : Module() {
  private val observers = mutableMapOf<Int, WeakReference<SurfaceGeometryObserver>>()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val generation = AtomicLong(0)
  @Volatile private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("KiloSurfaceGeometry")
    Events("onSurfaceGeometryChange")

    AsyncFunction("observeSurface") { tag: Int ->
      val currentGeneration = generation.get()
      if (destroyed) throw CodedException("The native surface observer is destroyed.")
      val root = appContext.findView<View>(tag)
        ?: throw CodedException("The native surface view is not mounted.")
      val existing = observers[tag]?.get()
      val observer = if (existing != null && existing.generation == currentGeneration && existing.observes(root)) {
        existing
      } else {
        observers.remove(tag)?.get()?.stop()
        val observer = SurfaceGeometryObserver(root, tag, currentGeneration, { geometry ->
          if (!destroyed && generation.get() == currentGeneration) {
            sendEvent("onSurfaceGeometryChange", geometry)
          }
        }, { stopped ->
          if (observers[tag]?.get() === stopped) observers.remove(tag)
        })
        observers[tag] = WeakReference(observer)
        observer.start()
        observer
      }
      val geometry = observer.snapshot()
      if (destroyed || generation.get() != currentGeneration) {
        observer.stop()
        throw CodedException("The native surface observer stopped.")
      }
      geometry
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("unobserveSurface") { tag: Int ->
      observers.remove(tag)?.get()?.stop()
      Unit
    }.runOnQueue(Queues.MAIN)

    OnStopObserving { stopObserving() }
    OnDestroy {
      destroyed = true
      stopObserving()
    }
  }

  private fun stopObserving() {
    val retiredGeneration = generation.getAndIncrement()
    val cleanup = Runnable {
      observers.values.mapNotNull { it.get() }.filter { it.generation <= retiredGeneration }.forEach { it.stop() }
      observers.entries.removeAll { it.value.get() == null }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) cleanup.run() else mainHandler.post(cleanup)
  }
}

private class SurfaceGeometryObserver(
  root: View,
  private val tag: Int,
  val generation: Long,
  private val emit: (Map<String, Any>) -> Unit,
  private val onStop: (SurfaceGeometryObserver) -> Unit
) : ViewTreeObserver.OnPreDrawListener, ViewTreeObserver.OnGlobalLayoutListener,
  View.OnAttachStateChangeListener {
  private val root = WeakReference(root)
  private var tree: ViewTreeObserver? = null
  private var previous: Map<String, Any>? = null
  private var attached = false
  private var stopped = false

  fun observes(view: View): Boolean = !stopped && root.get() === view

  fun start() {
    val root = root.get()
    if (stopped || root == null) {
      stop()
      return
    }
    root.addOnAttachStateChangeListener(this)
    attached = root.isAttachedToWindow
    if (attached) attachTree()
  }

  private fun attachTree() {
    val root = root.get()
    if (stopped || root == null) {
      stop()
      return
    }
    if (!attached) return
    detachTree()
    tree = root.viewTreeObserver.also {
      it.addOnPreDrawListener(this)
      it.addOnGlobalLayoutListener(this)
    }
  }

  private fun detachTree() {
    tree?.takeIf { it.isAlive }?.let {
      it.removeOnPreDrawListener(this)
      it.removeOnGlobalLayoutListener(this)
    }
    tree = null
  }

  override fun onPreDraw(): Boolean {
    if (!stopped && attached) snapshot()
    return true
  }

  override fun onGlobalLayout() {
    if (!stopped && attached) snapshot()
  }

  override fun onViewAttachedToWindow(view: View) {
    if (!observes(view)) return
    attached = true
    attachTree()
    snapshot()
  }

  override fun onViewDetachedFromWindow(view: View) {
    if (!observes(view)) return
    attached = false
    detachTree()
    snapshot()
  }

  fun snapshot(): Map<String, Any> {
    val root = root.get()
    if (stopped || root == null) {
      stop()
      return geometry(0f, 0f, 0f, 0f, 0f, 1.0)
    }
    val geometry = measure(root)
    if (geometry != previous) {
      previous = geometry
      emit(geometry)
    }
    return geometry
  }

  private fun measure(root: View): Map<String, Any> {
    val density = root.resources.displayMetrics.density.toDouble()
    val height = root.height.coerceAtLeast(0).toFloat()
    val toLocal = Matrix()
    val empty = geometry(0f, 0f, height, 0f, 0f, density)
    if (!attached || !root.isAttachedToWindow) return empty
    if (!localToScreen(root).invert(toLocal)) return empty
    val windowRoot = root.rootView
    val windowLocation = IntArray(2)
    windowRoot.getLocationOnScreen(windowLocation)
    val windowBounds = RectF(
      windowLocation[0].toFloat(), windowLocation[1].toFloat(),
      (windowLocation[0] + windowRoot.width).toFloat(),
      (windowLocation[1] + windowRoot.height).toFloat()
    )
    val insets = ViewCompat.getRootWindowInsets(root) ?: return empty
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val dockedKeyboard = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > bars.bottom
    val displayFrame = Rect()
    windowRoot.getWindowVisibleDisplayFrame(displayFrame)
    val safeWindow = RectF(windowBounds)
    safeWindow.top += bars.top
    if (!dockedKeyboard || windowBounds.bottom > displayFrame.bottom) {
      safeWindow.bottom -= bars.bottom
    }
    toLocal.mapRect(safeWindow)
    val safeTop = if (bars.top > 0) safeWindow.top.coerceIn(0f, height) else 0f
    val safeBottom = if (bars.bottom > 0) (height - safeWindow.bottom).coerceIn(0f, height) else 0f
    val invisible = geometry(0f, 0f, height, safeTop, safeBottom, density)
    if (!root.isShown || root.windowVisibility != View.VISIBLE) return invisible
    val globalVisible = Rect()
    if (!root.getGlobalVisibleRect(globalVisible)) return invisible
    globalVisible.offset(windowLocation[0], windowLocation[1])
    val visible = RectF(globalVisible)
    if (!visible.intersect(windowBounds)) return invisible
    var ancestor: View? = root
    var alpha = 1f
    while (ancestor != null) {
      alpha *= ancestor.alpha
      if (alpha <= 0.01f) return invisible
      val clip = ancestor.clipBounds
      if (clip != null) {
        val screenClip = RectF(clip)
        localToScreen(ancestor).mapRect(screenClip)
        if (!visible.intersect(screenClip)) return invisible
      }
      ancestor = ancestor.parent as? View
    }
    if (dockedKeyboard) {
      val mode = (windowRoot.layoutParams as? WindowManager.LayoutParams)?.softInputMode
      val adjustsNothing = mode != null &&
        mode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST == WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      val keyboardTop = if (adjustsNothing) windowBounds.bottom - ime.bottom else displayFrame.bottom.toFloat()
      visible.bottom = keyboardTop.coerceIn(visible.top, visible.bottom)
    }
    toLocal.mapRect(visible)
    val top = visible.top.coerceIn(0f, height)
    val bottom = visible.bottom.coerceIn(top, height)
    return geometry(top, bottom, height, safeTop, safeBottom, density)
  }

  private fun localToScreen(view: View): Matrix {
    val matrix = Matrix()
    var ancestor: View? = view
    while (ancestor != null) {
      matrix.postConcat(ancestor.matrix)
      matrix.postTranslate(ancestor.left.toFloat(), ancestor.top.toFloat())
      val parent = ancestor.parent as? View
      if (parent != null) matrix.postTranslate(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
      ancestor = parent
    }
    val origin = floatArrayOf(0f, 0f)
    matrix.mapPoints(origin)
    val location = IntArray(2)
    view.getLocationOnScreen(location)
    matrix.postTranslate(location[0] - origin[0], location[1] - origin[1])
    return matrix
  }

  private fun geometry(
    top: Float, bottom: Float, height: Float, safeTop: Float, safeBottom: Float, density: Double
  ): Map<String, Any> = mapOf(
    "tag" to tag,
    "visibleTop" to top / density,
    "visibleBottom" to bottom / density,
    "boundsHeight" to height / density,
    "safeAreaTop" to safeTop / density,
    "safeAreaBottom" to safeBottom / density
  )

  fun stop() {
    if (stopped) return
    stopped = true
    attached = false
    detachTree()
    root.get()?.removeOnAttachStateChangeListener(this)
    root.clear()
    onStop(this)
  }
}
