package expo.modules.localaccessprivacy

import android.app.Activity
import android.app.Application
import android.view.Window
import com.facebook.react.bridge.ReactContext

private fun expect(value: Boolean, message: String) {
  if (!value) throw AssertionError(message)
}

private class Fixture(private val application: Application) {
  val activity = Activity()
  val root = activity.window
  val context = ReactContext(activity)
  val events = mutableListOf<Map<String, Any>>()
  val generation get() = LocalAccessPrivacy.snapshot()["generation"] as Long

  init {
    root.decorView.windowId?.isFocused = true
    root.decorView.focus = true
    application.callbacks.onActivityCreated(activity, null)
    application.callbacks.onActivityResumed(activity)
    LocalAccessPrivacy.attach(context)
    LocalAccessPrivacy.arm()
    expect(LocalAccessPrivacy.publish(generation), "Fixture must publish current access")
    LocalAccessPrivacy.emit = { name, snapshot ->
      if (name == "onVisibilityChange") events.add(snapshot)
    }
  }

  fun dialog(): Window {
    val dialog = Window()
    context.listeners.single().onExtraWindowCreate(dialog)
    return dialog
  }

  fun focus(dialog: Window) {
    root.decorView.windowId?.isFocused = false
    dialog.decorView.windowId?.isFocused = true
    dialog.decorView.dispatchWindowFocus(true)
    root.decorView.dispatchWindowFocus(false)
  }

  fun dispose() {
    LocalAccessPrivacy.emit = null
    application.callbacks.onActivityDestroyed(activity)
    LocalAccessPrivacy.disarm()
    LocalAccessPrivacy.detach()
  }
}

fun main() {
  val application = Application()
  LocalAccessPrivacy.install(application)
  val failures = mutableListOf<String>()
  var passed = 0
  fun test(name: String, body: (Fixture) -> Unit) {
    val fixture = Fixture(application)
    try {
      body(fixture)
      passed += 1
      println("PASS: $name")
    } catch (error: AssertionError) {
      failures.add("$name: ${error.message}")
    } finally {
      fixture.dispose()
    }
  }

  test("Activity loss before application dialog gain preserves published content") { fixture ->
    val generation = fixture.generation
    val clears = fixture.root.focusClears
    val dialog = fixture.dialog()
    // WindowManager has transferred ownership, but neither View has delivered the gain yet.
    fixture.root.decorView.windowId?.isFocused = false
    dialog.decorView.windowId?.isFocused = true
    fixture.root.decorView.dispatchWindowFocus(false)
    expect(!fixture.root.covered && !dialog.covered, "The callback gap must not cover application content")
    expect(fixture.root.inputFocused && fixture.root.focusClears == clears, "The callback gap must not clear input focus")
    expect(LocalAccessPrivacy.foregroundAllowed(), "The application transfer must retain admission")
    dialog.decorView.dispatchWindowFocus(true)
    expect(fixture.generation == generation && fixture.events.isEmpty(), "The transfer must not request a new handshake")
  }

  test("Modal detachment before WindowManager removal preserves published content") { fixture ->
    val dialog = fixture.dialog()
    fixture.focus(dialog)
    val generation = fixture.generation
    val clears = fixture.root.focusClears
    val nativeWindow = requireNotNull(dialog.decorView.windowId)
    // React Native emits destruction before Dialog.dismiss, while the Modal still owns focus.
    fixture.context.listeners.single().onExtraWindowDestroy(dialog)
    expect(!fixture.root.covered && !dialog.covered, "The pre-dismiss callback must not blank either window")
    expect(LocalAccessPrivacy.foregroundAllowed(), "The attached Modal must retain native focus authority")
    // ViewRootImpl detaches decor BEFORE mWindowSession.remove transfers native focus.
    dialog.decorView.detach()
    expect(!fixture.root.covered && fixture.root.inputFocused, "Detachment must preserve visible content and input focus")
    expect(LocalAccessPrivacy.foregroundAllowed(), "The current native owner must bridge decor detachment")
    expect(dialog.decorView.onChange == null && dialog.decorView.onDetach == null, "Detachment must remove the View listeners")
    nativeWindow.isFocused = false
    fixture.root.decorView.windowId?.isFocused = true
    // WindowState removes the input token, so the old WindowId need not deliver a loss callback.
    dialog.decorView.dispatchPostedActions()
    expect(nativeWindow.observers.isEmpty(), "The post-removal checkpoint must release the native focus observer")
    fixture.root.decorView.dispatchWindowFocus(true)
    expect(fixture.generation == generation && fixture.root.focusClears == clears && fixture.events.isEmpty(), "Returning focus must preserve the publication")
  }

  test("A pre-dismiss Modal still covers when a system prompt takes focus") { fixture ->
    val dialog = fixture.dialog()
    fixture.focus(dialog)
    fixture.context.listeners.single().onExtraWindowDestroy(dialog)
    dialog.decorView.windowId?.isFocused = false
    dialog.decorView.dispatchWindowFocus(false)
    expect(fixture.root.covered && dialog.covered, "The still-attached Modal must remain protected")
    expect(!LocalAccessPrivacy.foregroundAllowed(), "A destruction notice cannot override native focus loss")
  }

  test("A detached Modal cannot preserve admission after native focus loss") { fixture ->
    val dialog = fixture.dialog()
    fixture.focus(dialog)
    val nativeWindow = requireNotNull(dialog.decorView.windowId)
    fixture.context.listeners.single().onExtraWindowDestroy(dialog)
    dialog.decorView.detach()
    nativeWindow.isFocused = false
    // Query before either native observer or View focus callbacks can deliver the loss.
    expect(!LocalAccessPrivacy.foregroundAllowed() && fixture.root.covered, "A retained identity must query current native focus")
    expect(nativeWindow.observers.isEmpty(), "A synchronous denial must release the dismissed observer")
    fixture.context.listeners.single().onExtraWindowDestroy(dialog)
    expect(!LocalAccessPrivacy.foregroundAllowed(), "Repeated destruction must not restore authority")
  }

  for (nativeCallback in listOf(false, true)) {
    test("Post-detach focus loss protects attached windows (native callback: $nativeCallback)") { fixture ->
      val remaining = fixture.dialog()
      val dialog = fixture.dialog()
      fixture.focus(dialog)
      val nativeWindow = requireNotNull(dialog.decorView.windowId)
      fixture.context.listeners.single().onExtraWindowDestroy(dialog)
      dialog.decorView.detach()
      expect(!fixture.root.covered && !remaining.covered, "Detachment alone must not revoke publication")
      nativeWindow.isFocused = false
      if (nativeCallback) nativeWindow.dispatchFocusChange() else dialog.decorView.dispatchPostedActions()
      expect(fixture.root.covered && remaining.covered, "A system prompt must cover without a detached View callback")
      expect(!LocalAccessPrivacy.foregroundAllowed(), "Current native focus must deny prompt-time access")
      expect(nativeWindow.observers.isEmpty(), "The dismissed native observer must be removed")
      expect(remaining.decorView.onChange != null && remaining.decorView.onDetach != null, "Still-attached windows must retain their protection listeners")
    }
  }

  test("A rejected removal checkpoint fails closed") { fixture ->
    val dialog = fixture.dialog()
    fixture.focus(dialog)
    dialog.decorView.acceptsPosts = false
    fixture.context.listeners.single().onExtraWindowDestroy(dialog)
    dialog.decorView.detach()
    expect(fixture.root.covered, "A failed native checkpoint must immediately protect attached content")
    expect(fixture.events.lastOrNull()?.get("failed") == true, "The native failure must notify the shell after covering")
    expect(!LocalAccessPrivacy.foregroundAllowed(), "A failed native checkpoint cannot admit effects")
    expect(!LocalAccessPrivacy.publish(fixture.generation), "A current generation cannot bypass native failure")
  }

  test("System prompt focus loss covers immediately with an application dialog open") { fixture ->
    val dialog = fixture.dialog()
    fixture.focus(dialog)
    val generation = fixture.generation
    LocalAccessPrivacy.setGate(generation, PrivacyGate(listOf(PrivacyGateAction("retry"))))
    dialog.decorView.windowId?.isFocused = false
    dialog.decorView.dispatchWindowFocus(false)
    expect(fixture.root.covered && dialog.covered, "A system prompt must synchronously cover all application windows")
    expect(!LocalAccessPrivacy.foregroundAllowed(), "A system prompt must deny application effects")
    expect(!fixture.root.gateVisible && !dialog.gateVisible, "Application gates must stay passive over system prompts")
    expect(!LocalAccessPrivacy.publish(generation), "Prompt focus loss must invalidate the old publication")
    expect(!LocalAccessPrivacy.publish(fixture.generation), "A current generation cannot uncover while a prompt owns focus")
  }

  for (detachBeforePause in listOf(false, true)) {
    test("Activity pause denies access during dismissal (detached: $detachBeforePause)") { fixture ->
      val dialog = fixture.dialog()
      fixture.focus(dialog)
      val nativeWindow = requireNotNull(dialog.decorView.windowId)
      fixture.context.listeners.single().onExtraWindowDestroy(dialog)
      if (detachBeforePause) dialog.decorView.detach()
      application.callbacks.onActivityPrePaused(fixture.activity)
      expect(fixture.root.covered && (detachBeforePause || dialog.covered), "Activity inactivity must not await a focus callback")
      expect(!LocalAccessPrivacy.foregroundAllowed(), "A paused Activity cannot admit effects through its dialog")
      if (!detachBeforePause) dialog.decorView.detach()
      expect(fixture.root.covered && !LocalAccessPrivacy.foregroundAllowed(), "Detachment cannot override Activity inactivity")
      expect(nativeWindow.observers.isEmpty(), "An inactive Activity must not retain a dismissed observer")
    }
  }

  test("Synchronous admission rejects native focus loss before the View callback") { fixture ->
    fixture.root.decorView.windowId?.isFocused = false
    expect(!LocalAccessPrivacy.foregroundAllowed(), "A stale View focus bit must not authorize effects")
    expect(fixture.root.covered, "The synchronous native check must cover before returning denial")
  }

  test("Missing native window identity fails closed despite cached View focus") { fixture ->
    fixture.root.decorView.windowId = null
    fixture.root.decorView.dispatchWindowFocus(true)
    expect(fixture.root.covered && !LocalAccessPrivacy.foregroundAllowed(), "Missing native focus evidence must deny admission")
  }

  test("Detached windows cannot preserve admission") { fixture ->
    fixture.root.decorView.isAttachedToWindow = false
    fixture.root.decorView.dispatchWindowFocus(false)
    expect(fixture.root.covered && !LocalAccessPrivacy.foregroundAllowed(), "A detached window cannot authorize visibility")
  }

  test("Returning from a system prompt requires a fresh visibility handshake") { fixture ->
    val old = fixture.generation
    fixture.root.decorView.windowId?.isFocused = false
    fixture.root.decorView.dispatchWindowFocus(false)
    fixture.root.decorView.windowId?.isFocused = true
    fixture.root.decorView.dispatchWindowFocus(true)
    expect(fixture.root.covered && !LocalAccessPrivacy.foregroundAllowed(), "Native focus gain alone must not uncover")
    expect(!LocalAccessPrivacy.publish(old), "An old generation must remain rejected after focus returns")
    expect(LocalAccessPrivacy.publish(fixture.generation) && !fixture.root.covered, "Only a fresh handshake can reveal content")
  }

  println("LocalAccessPrivacy Android coordinator: $passed/14 cases passed")
  check(failures.isEmpty()) { failures.joinToString("\n") }
}
