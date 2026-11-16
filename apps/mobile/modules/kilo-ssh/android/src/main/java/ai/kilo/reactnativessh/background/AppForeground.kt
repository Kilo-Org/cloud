package ai.kilo.reactnativessh.background

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

internal fun isAppForeground(): Boolean =
  ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

/**
 * Runs [block] now when the app is on screen, or once it next comes back.
 *
 * Like [ProcessLifecycleOwner], main thread only.
 */
internal fun runWhenForeground(block: () -> Unit) {
  val lifecycle = ProcessLifecycleOwner.get().lifecycle

  if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
    block()
    return
  }

  lifecycle.addObserver(object : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) {
      lifecycle.removeObserver(this)
      block()
    }
  })
}
