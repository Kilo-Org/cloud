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

/** Ints per ancestor in the signal's clip walk: presence, left, top, right, bottom. */
private const val CLIP_STRIDE = 5

/**
 * Android's surface-geometry probe: a `ViewTreeObserver.OnPreDrawListener`,
 * joined by a global-layout and an attach-state listener, so the geometry
 * follows a pass the framework is about to draw.
 *
 * The pre-draw listener is the capability Android has and iOS does not. iOS's
 * counterpart (`ios/KiloSurfaceGeometryModule.swift`) is a `UIView` probe whose
 * `schedule()` already coalesces its invalidation to at most one measurement
 * per main-queue turn, and it registers no pre-draw listener; that is why the
 * cheap-signal gate below lives here. Both sides emit the one event and the one
 * six-value contract in `src/lib/native-surface-geometry.ts`.
 */
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
  private var attached = false
  private var stopped = false

  // Scratch objects and holders, reused on every pass so the steady state
  // allocates nothing: the root inverse and the ancestor clip matrix, the rects
  // the measurement and the signal write through, the rect the signal reads the
  // framework's clip bounds into, the window/root location and the origin.
  private val toLocalMatrix = Matrix()
  private val ancestorMatrix = Matrix()
  private val windowBounds = RectF()
  private val displayFrame = Rect()
  private val safeWindow = RectF()
  private val globalVisible = Rect()
  private val visible = RectF()
  private val clipBounds = RectF()
  private val clipRead = Rect()
  private val windowLocation = IntArray(2)
  private val origin = FloatArray(2)

  // The six measured values, compared as values instead of as whole Maps.
  private val current = GeometryValues(tag)
  private val previous = GeometryValues(tag)
  private var previousMap: Map<String, Any> = emptyMap()
  private var hasMeasured = false

  // The cheap per-pass signal: the measurement runs only when one of these
  // changed, or when a layout, inset, attach or detach marked the state dirty.
  private var dirty = true
  private var hasSignal = false
  private var lastHeight = 0
  private var lastAttached = false
  private var lastShown = false
  private var lastWindowVisibility = 0
  private var lastScreenX = 0
  private var lastScreenY = 0
  private var lastScroll = 0
  private var lastAlpha = 1f

  // The ancestor clip walk, `CLIP_STRIDE` ints per ancestor, kept in two reused
  // buffers and compared value by value, so the signal never allocates and never
  // misses a clip-bounds-only change.
  private var lastClipCount = -1
  private var clipWalk = IntArray(0)
  private var previousClipWalk = IntArray(0)

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
    if (stopped || !attached) return true
    val view = root.get() ?: return true
    if (signalChanged(view) || dirty) snapshot()
    return true
  }

  override fun onGlobalLayout() {
    if (stopped || !attached) return
    dirty = true
    snapshot()
  }

  override fun onViewAttachedToWindow(view: View) {
    if (!observes(view)) return
    attached = true
    dirty = true
    attachTree()
    snapshot()
  }

  override fun onViewDetachedFromWindow(view: View) {
    if (!observes(view)) return
    attached = false
    dirty = true
    detachTree()
    snapshot()
  }

  /**
   * The allocation-free signal the pre-draw pass gates on. It covers every input
   * `measure` reads between layout events: the root's height, attachment, shown
   * state and window visibility, its screen location written into the
   * preallocated array, the ancestor scroll offsets, and the ancestor walk's
   * alpha product and clip bounds. A change here is the only thing that starts a
   * measurement between layout events.
   */
  private fun signalChanged(root: View): Boolean {
    root.getLocationOnScreen(windowLocation)
    var scroll = 0
    var alpha = 1f
    var clipCount = 0
    var ancestor: View? = root
    while (ancestor != null) {
      alpha *= ancestor.alpha
      val base = clipCount * CLIP_STRIDE
      if (base + CLIP_STRIDE > clipWalk.size) {
        clipWalk = clipWalk.copyOf(maxOf(CLIP_STRIDE, clipWalk.size * 2))
      }
      if (ancestor.getClipBounds(clipRead)) {
        clipWalk[base] = 1
        clipWalk[base + 1] = clipRead.left
        clipWalk[base + 2] = clipRead.top
        clipWalk[base + 3] = clipRead.right
        clipWalk[base + 4] = clipRead.bottom
      } else {
        clipWalk[base] = 0
        clipWalk[base + 1] = 0
        clipWalk[base + 2] = 0
        clipWalk[base + 3] = 0
        clipWalk[base + 4] = 0
      }
      clipCount += 1
      val parent = ancestor.parent as? View
      if (parent != null) scroll += parent.scrollX + parent.scrollY
      ancestor = parent
    }
    val attachedNow = attached && root.isAttachedToWindow
    val shown = root.isShown
    val windowVisibility = root.windowVisibility
    val height = root.height
    val changed = !hasSignal ||
      height != lastHeight ||
      attachedNow != lastAttached ||
      shown != lastShown ||
      windowVisibility != lastWindowVisibility ||
      windowLocation[0] != lastScreenX ||
      windowLocation[1] != lastScreenY ||
      scroll != lastScroll ||
      alpha != lastAlpha ||
      !sameClipWalk(clipCount)
    hasSignal = true
    lastHeight = height
    lastAttached = attachedNow
    lastShown = shown
    lastWindowVisibility = windowVisibility
    lastScreenX = windowLocation[0]
    lastScreenY = windowLocation[1]
    lastScroll = scroll
    lastAlpha = alpha
    rememberClipWalk(clipCount)
    return changed
  }

  /** Compares the clip walk just built against the previous pass, value by value. */
  private fun sameClipWalk(count: Int): Boolean {
    if (count != lastClipCount) return false
    for (index in 0 until count * CLIP_STRIDE) {
      if (clipWalk[index] != previousClipWalk[index]) return false
    }
    return true
  }

  /** Keeps the clip walk just built as the next baseline, by swapping the reused buffers. */
  private fun rememberClipWalk(count: Int) {
    val justBuilt = clipWalk
    clipWalk = previousClipWalk
    previousClipWalk = justBuilt
    lastClipCount = count
  }

  fun snapshot(): Map<String, Any> {
    val root = root.get()
    if (stopped || root == null) {
      stop()
      current.set(0f, 0f, 0f, 0f, 0f, 1.0)
      return current.toMap()
    }
    measure(root, current)
    dirty = false
    if (!hasMeasured || !current.sameAs(previous)) {
      hasMeasured = true
      previous.copyFrom(current)
      previousMap = current.toMap()
      emit(previousMap)
    }
    return previousMap
  }

  private fun measure(root: View, result: GeometryValues) {
    val density = root.resources.displayMetrics.density.toDouble()
    val height = root.height.coerceAtLeast(0).toFloat()
    if (!attached || !root.isAttachedToWindow) {
      result.set(0f, 0f, height, 0f, 0f, density)
      return
    }
    localToScreen(root, toLocalMatrix)
    if (!toLocalMatrix.invert(toLocalMatrix)) {
      result.set(0f, 0f, height, 0f, 0f, density)
      return
    }
    val windowRoot = root.rootView
    windowRoot.getLocationOnScreen(windowLocation)
    windowBounds.set(
      windowLocation[0].toFloat(),
      windowLocation[1].toFloat(),
      (windowLocation[0] + windowRoot.width).toFloat(),
      (windowLocation[1] + windowRoot.height).toFloat()
    )
    val insets = ViewCompat.getRootWindowInsets(root)
    if (insets == null) {
      result.set(0f, 0f, height, 0f, 0f, density)
      return
    }
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val dockedKeyboard = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > bars.bottom
    windowRoot.getWindowVisibleDisplayFrame(displayFrame)
    safeWindow.set(windowBounds)
    safeWindow.top += bars.top
    if (!dockedKeyboard || windowBounds.bottom > displayFrame.bottom) {
      safeWindow.bottom -= bars.bottom
    }
    toLocalMatrix.mapRect(safeWindow)
    val safeTop = if (bars.top > 0) safeWindow.top.coerceIn(0f, height) else 0f
    val safeBottom = if (bars.bottom > 0) (height - safeWindow.bottom).coerceIn(0f, height) else 0f
    if (!root.isShown || root.windowVisibility != View.VISIBLE) {
      result.set(0f, 0f, height, safeTop, safeBottom, density)
      return
    }
    if (!root.getGlobalVisibleRect(globalVisible)) {
      result.set(0f, 0f, height, safeTop, safeBottom, density)
      return
    }
    globalVisible.offset(windowLocation[0], windowLocation[1])
    visible.set(globalVisible)
    if (!visible.intersect(windowBounds)) {
      result.set(0f, 0f, height, safeTop, safeBottom, density)
      return
    }
    var ancestor: View? = root
    var alpha = 1f
    while (ancestor != null) {
      alpha *= ancestor.alpha
      if (alpha <= 0.01f) {
        result.set(0f, 0f, height, safeTop, safeBottom, density)
        return
      }
      val clip = ancestor.clipBounds
      if (clip != null) {
        clipBounds.set(clip)
        localToScreen(ancestor, ancestorMatrix)
        ancestorMatrix.mapRect(clipBounds)
        if (!visible.intersect(clipBounds)) {
          result.set(0f, 0f, height, safeTop, safeBottom, density)
          return
        }
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
    toLocalMatrix.mapRect(visible)
    val top = visible.top.coerceIn(0f, height)
    val bottom = visible.bottom.coerceIn(top, height)
    result.set(top, bottom, height, safeTop, safeBottom, density)
  }

  /** Writes `view`'s transform into `result` instead of returning a new matrix. */
  private fun localToScreen(view: View, result: Matrix) {
    result.reset()
    var ancestor: View? = view
    while (ancestor != null) {
      result.postConcat(ancestor.matrix)
      result.postTranslate(ancestor.left.toFloat(), ancestor.top.toFloat())
      val parent = ancestor.parent as? View
      if (parent != null) {
        result.postTranslate(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
      }
      ancestor = parent
    }
    origin[0] = 0f
    origin[1] = 0f
    result.mapPoints(origin)
    view.getLocationOnScreen(windowLocation)
    result.postTranslate(windowLocation[0] - origin[0], windowLocation[1] - origin[1])
  }

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

/**
 * The six measured values, held mutably so a pass compares them by value
 * (`tag`, `visibleTop`, `visibleBottom`, `boundsHeight`, `safeAreaTop`,
 * `safeAreaBottom`) instead of comparing whole Maps. `toMap()` is the only map
 * the observer builds, and only when one of the values changed.
 */
private class GeometryValues(private val tag: Int) {
  var visibleTop = 0f
  var visibleBottom = 0f
  var boundsHeight = 0f
  var safeAreaTop = 0f
  var safeAreaBottom = 0f
  var density = 1.0

  fun set(
    visibleTop: Float,
    visibleBottom: Float,
    boundsHeight: Float,
    safeAreaTop: Float,
    safeAreaBottom: Float,
    density: Double
  ) {
    this.visibleTop = visibleTop
    this.visibleBottom = visibleBottom
    this.boundsHeight = boundsHeight
    this.safeAreaTop = safeAreaTop
    this.safeAreaBottom = safeAreaBottom
    this.density = density
  }

  fun copyFrom(other: GeometryValues) {
    visibleTop = other.visibleTop
    visibleBottom = other.visibleBottom
    boundsHeight = other.boundsHeight
    safeAreaTop = other.safeAreaTop
    safeAreaBottom = other.safeAreaBottom
    density = other.density
  }

  fun sameAs(other: GeometryValues): Boolean {
    return tag == other.tag &&
      visibleTop == other.visibleTop &&
      visibleBottom == other.visibleBottom &&
      boundsHeight == other.boundsHeight &&
      safeAreaTop == other.safeAreaTop &&
      safeAreaBottom == other.safeAreaBottom &&
      density == other.density
  }

  fun toMap(): Map<String, Any> = mapOf(
    "tag" to tag,
    "visibleTop" to visibleTop / density,
    "visibleBottom" to visibleBottom / density,
    "boundsHeight" to boundsHeight / density,
    "safeAreaTop" to safeAreaTop / density,
    "safeAreaBottom" to safeAreaBottom / density
  )
}
