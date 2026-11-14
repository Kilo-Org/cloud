package ai.kilo.reactnativessh.terminal

import android.os.Bundle
import android.view.View
import com.facebook.react.bridge.Arguments
import expo.modules.kotlin.events.EventEmitter

/**
 * Routes view events through the module's event emitter, the only public path from a view to its
 * JavaScript listeners.
 */
internal object TerminalViewEvents {

  @Volatile
  private var emitter: EventEmitter? = null

  fun install(emitter: EventEmitter?) {
    this.emitter = emitter
  }

  fun emit(view: View, eventName: String, body: Bundle = Bundle.EMPTY) {
    emitter?.emit(view, eventName, Arguments.fromBundle(body))
  }
}
