package ai.kilo.reactnativessh.background

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

internal fun isAppForeground(): Boolean =
  ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
