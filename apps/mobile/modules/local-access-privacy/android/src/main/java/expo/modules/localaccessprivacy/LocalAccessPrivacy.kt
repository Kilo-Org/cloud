package expo.modules.localaccessprivacy

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowId
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.fragment.app.FragmentManager
import com.facebook.react.bridge.ReactContext
import com.facebook.react.interfaces.ExtraWindowEventListener
import com.facebook.react.views.modal.ReactModalHostView

internal object LocalAccessPrivacy : Application.ActivityLifecycleCallbacks, ExtraWindowEventListener {
  var emit: ((String, Map<String, Any>) -> Unit)? = null
  private val state = PrivacyVisibilityState()
  private var installed = false
  private var reactContext: ReactContext? = null
  private val activities = mutableSetOf<Activity>()
  private val resumed = mutableSetOf<Activity>()
  private val windows = linkedMapOf<Window, ApplicationWindowCover>()
  private val detachingFocus = mutableMapOf<WindowId, Activity>()
  private val focusObserver = object : WindowId.FocusObserver() {
    override fun onFocusGained(token: WindowId?) { refresh() }
    override fun onFocusLost(token: WindowId?) { refresh() }
  }
  private var gate: PrivacyGate? = null
  private var gateGeneration = -1L
  private var refreshing = false

  private val fragments = object : FragmentManager.FragmentLifecycleCallbacks() {
    // Required public pre-show callback. onFragmentStarted follows Dialog.show(), while
    // onFragmentViewCreated never runs for viewless AlertFragments. Do not replace this hook.
    @Suppress("DEPRECATION")
    override fun onFragmentActivityCreated(fm: FragmentManager, f: Fragment, savedInstanceState: Bundle?) {
      if (state.isArmed) registerDialog(f)
    }

    override fun onFragmentStarted(fm: FragmentManager, f: Fragment) {
      // Unarmed focus tracking only. Protected dialogs use the earlier pre-show callback.
      if (!state.isArmed) registerDialog(f)
    }

    override fun onFragmentDestroyed(fm: FragmentManager, f: Fragment) {
      if (f is DialogFragment) f.dialog?.window?.let(::unregister)
    }
  }

  fun install(application: Application) {
    if (installed) return
    installed = true
    application.registerActivityLifecycleCallbacks(this)
  }

  fun attach(context: ReactContext) {
    if (reactContext !== context) {
      detach()
      reactContext = context
      context.addExtraWindowEventListener(this)
    }
    context.currentActivity?.let(::registerActivity)
    // ReactContext does not replay extra-window events. Seed exposed Modal/fragment windows.
    activities.toList().forEach { activity ->
      seedModals(activity.window.decorView, activity)
      if (activity is FragmentActivity) seedFragments(activity.supportFragmentManager)
    }
    refresh()
  }

  fun detach() {
    reactContext?.removeExtraWindowEventListener(this)
    reactContext = null
  }

  private fun seedModals(view: View, activity: Activity) {
    if (view is ReactModalHostView) view.dialog?.window?.let { register(it, activity, false) }
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) seedModals(view.getChildAt(index), activity)
    }
  }

  private fun seedFragments(manager: FragmentManager) {
    manager.fragments.forEach { fragment ->
      registerDialog(fragment)
      seedFragments(fragment.childFragmentManager)
    }
  }

  private fun registerDialog(fragment: Fragment) {
    if (fragment !is DialogFragment || !fragment.showsDialog) return
    // AndroidX owns the pre-28 fingerprint prompt. It is authentication UI, not application content.
    if (fragment.javaClass.name.startsWith("androidx.biometric.")) return
    val dialog = fragment.dialog ?: return
    dialog.create()
    dialog.window?.let { register(it, fragment.requireActivity(), false) }
  }

  private fun registerActivity(activity: Activity) {
    if (!activities.add(activity)) return
    register(activity.window, activity, true)
    if (activity is FragmentActivity) {
      activity.supportFragmentManager.registerFragmentLifecycleCallbacks(fragments, true)
    }
  }

  private fun register(window: Window, activity: Activity?, activityWindow: Boolean) {
    if (!windows.containsKey(window)) {
      windows[window] = ApplicationWindowCover(window, activity, activityWindow,
        onChange = { refresh() }, onDetach = { detachWindow(window) })
    }
    refresh()
  }

  private fun detachWindow(window: Window) {
    val activity = windows[window]?.activity
    val nativeId = window.decorView.windowId
    // View detachment precedes WindowManager removal. Retain the live native identity, not a focus bit.
    // WindowId remains available in this callback, before View clears its AttachInfo.
    if (activity != null && window !== activity.window && nativeId != null && !detachingFocus.containsKey(nativeId)) {
      detachingFocus[nativeId] = activity
      nativeId.registerFocusObserver(focusObserver)
    }
    // Removal can discard the input token before WindowId delivers focus loss.
    // The attached View's UI Handler runs this checkpoint after the synchronous removal stack returns.
    // This checkpoint grants no grace period: refresh still queries current native focus.
    val checkpointPosted = window.decorView.post { refresh() }
    if (!checkpointPosted) state.fail()
    unregister(window)
    if (!checkpointPosted) notifyChange()
  }

  private fun unregister(window: Window) {
    windows.remove(window)?.dispose()
    refresh()
  }

  override fun onExtraWindowCreate(window: Window) {
    // React Native emits this synchronously after show, before the scheduled traversal.
    // Prearmed Activity FLAG_SECURE already reaches the Modal before show.
    register(window, reactContext?.currentActivity, false)
  }

  override fun onExtraWindowDestroy(window: Window) {
    // React Native emits this before Dialog.dismiss(), while the Modal can still own native focus.
    // Keep coverage until decor detaches; its native identity survives until focus transfers.
    if (!window.decorView.isAttachedToWindow) unregister(window)
  }

  override fun onActivityPreCreated(activity: Activity, savedInstanceState: Bundle?) = registerActivity(activity)
  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = registerActivity(activity)
  override fun onActivityResumed(activity: Activity) {
    registerActivity(activity)
    resumed.add(activity)
    refresh()
  }
  override fun onActivityPrePaused(activity: Activity) = pause(activity)
  override fun onActivityPaused(activity: Activity) = pause(activity)
  override fun onActivityStopped(activity: Activity) = pause(activity)
  override fun onActivityStarted(activity: Activity) = Unit
  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

  private fun pause(activity: Activity) {
    resumed.remove(activity)
    refresh()
  }

  override fun onActivityDestroyed(activity: Activity) {
    resumed.remove(activity)
    activities.remove(activity)
    if (activity is FragmentActivity) {
      activity.supportFragmentManager.unregisterFragmentLifecycleCallbacks(fragments)
    }
    windows.values.filter { it.activity === activity }.map { it.window }.forEach(::unregister)
    refresh()
  }

  private fun refresh() {
    if (refreshing) return
    refreshing = true
    try {
      val generation = state.generation
      // Observe removal without relying on a detached View to deliver another focus callback.
      detachingFocus.toMap().forEach { (nativeId, activity) ->
        if (!resumed.contains(activity) || !nativeId.isFocused) {
          detachingFocus.remove(nativeId)
          nativeId.unregisterFocusObserver(focusObserver)
        }
      }
      // WindowId queries native ownership instead of each View's last delivered focus callback.
      // An application transfer can deliver the old window's loss before the new dialog's gain.
      // No focus event is sent to the TypeScript background clock or authentication service.
      state.setForeground(windows.values.any {
        val decor = it.window.decorView
        resumed.contains(it.activity) && decor.isAttachedToWindow && decor.windowId?.isFocused == true
      } || detachingFocus.isNotEmpty())
      windows.values.toList().forEach {
        it.apply(state.isArmed, state.isCovered,
          if (state.isForeground && gateGeneration == state.generation) gate else null,
          state.generation, ::gateAction)
      }
      if (generation != state.generation) notifyChange()
    } catch (error: RuntimeException) {
      state.fail()
      notifyChange()
      throw error
    } finally {
      refreshing = false
    }
  }

  fun arm() {
    state.arm()
    check(installed && reactContext != null) { "Native privacy lifecycle is unavailable" }
    refresh()
    notifyChange()
  }

  fun disarm() {
    state.disarm()
    gate = null
    refresh()
    notifyChange()
  }

  fun cover() {
    state.cover()
    refresh()
    notifyChange()
  }

  fun publish(generation: Long): Boolean {
    refresh()
    val wasCovered = state.isCovered
    if (!state.publish(generation)) return false
    if (wasCovered) {
      refresh()
      // Duplicate publication must not move focus or emit another visibility event.
      windows.values.firstOrNull { it.hasFocus() }?.restoreFocus()
      notifyChange()
    }
    return true
  }

  fun snapshot(): Map<String, Any> {
    refresh()
    return stateMap()
  }

  fun foregroundAllowed(): Boolean {
    refresh()
    return state.admitsForeground()
  }

  fun setGate(generation: Long, value: PrivacyGate?): Boolean {
    refresh()
    if (!state.isArmed || state.generation != generation) return false
    gate = value
    gateGeneration = generation
    windows.values.forEach { it.resetGate() }
    refresh()
    return true
  }

  private fun gateAction(generation: Long, id: String) {
    refresh()
    if (state.isCovered && state.isForeground && state.generation == generation &&
      gate?.actions?.any { it.id == id && it.enabled } == true) {
      emit?.invoke("onGateAction", mapOf("generation" to generation, "id" to id))
    }
  }

  @Suppress("DEPRECATION")
  fun announce(message: String, generation: Long, gate: Boolean): Boolean {
    refresh()
    if (!state.admitsAnnouncement(generation, gate)) return false
    val context = reactContext ?: return false
    val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    if (!manager.isEnabled) return false
    val event = AccessibilityEvent.obtain(AccessibilityEvent.TYPE_ANNOUNCEMENT)
    event.packageName = context.packageName
    event.className = LocalAccessPrivacyModule::class.java.name
    event.text.add(message)
    manager.sendAccessibilityEvent(event)
    return true
  }

  private fun stateMap(): Map<String, Any> = mapOf(
    "generation" to state.generation, "armed" to state.isArmed, "foreground" to state.isForeground,
    "covered" to state.isCovered, "failed" to state.isFailed)

  private fun notifyChange() { emit?.invoke("onVisibilityChange", stateMap()) }
}
