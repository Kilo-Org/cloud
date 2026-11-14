package ai.kilo.reactnativessh.terminal

import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalViewClient

internal class TerminalViewClientBridge(
  private val view: ReactNativeSshTerminalView,
) : TerminalViewClient {

  override fun onScale(scale: Float): Float = view.onScaleGesture(scale)

  override fun onSingleTapUp(e: MotionEvent) {
    view.handleSingleTap(e)
  }

  override fun shouldBackButtonBeMappedToEscape(): Boolean = false

  override fun shouldEnforceCharBasedInput(): Boolean = true

  override fun shouldUseCtrlSpaceWorkaround(): Boolean = false

  override fun isTerminalViewSelected(): Boolean = view.terminal.isFocused

  override fun copyModeChanged(copyMode: Boolean) {
    view.emitSelectionChange(copyMode)
  }

  override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean =
    view.handleMetaKey(e, session)

  override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean = false

  override fun onLongPress(event: MotionEvent): Boolean = false

  override fun readControlKey(): Boolean = false

  override fun readAltKey(): Boolean = false

  override fun readShiftKey(): Boolean = false

  override fun readFnKey(): Boolean = false

  override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean = false

  override fun onEmulatorSet() {
    view.onEmulatorReady()
  }

  override fun logError(tag: String, message: String) {
    Log.e(tag, message)
  }

  override fun logWarn(tag: String, message: String) {
    Log.w(tag, message)
  }

  override fun logInfo(tag: String, message: String) {
    Log.i(tag, message)
  }

  override fun logDebug(tag: String, message: String) {
    Log.d(tag, message)
  }

  override fun logVerbose(tag: String, message: String) {
    Log.v(tag, message)
  }

  override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) {
    Log.e(tag, message, e)
  }

  override fun logStackTrace(tag: String, e: Exception) {
    Log.e(tag, e.message, e)
  }
}

internal class TerminalSessionClientBridge(
  private val view: ReactNativeSshTerminalView,
) : TerminalSessionClient {

  override fun onTextChanged(changedSession: TerminalSession) {
    view.onScreenUpdated()
  }

  override fun onTitleChanged(changedSession: TerminalSession) {
    view.emitTitleChange(changedSession.title)
  }

  override fun onSessionFinished(finishedSession: TerminalSession) = Unit

  override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
    view.copyToClipboard(text)
  }

  override fun onPasteTextFromClipboard(session: TerminalSession) {
    view.pasteFromClipboard()
  }

  override fun onBell(session: TerminalSession) {
    view.emitBell()
  }

  override fun onColorsChanged(session: TerminalSession) {
    view.terminal.invalidate()
  }

  override fun onTerminalCursorStateChange(state: Boolean) {
    view.terminal.setTerminalCursorBlinkerState(state, true)
  }

  override fun getTerminalCursorStyle(): Int = view.cursorStyleValue

  override fun logError(tag: String, message: String) {
    Log.e(tag, message)
  }

  override fun logWarn(tag: String, message: String) {
    Log.w(tag, message)
  }

  override fun logInfo(tag: String, message: String) {
    Log.i(tag, message)
  }

  override fun logDebug(tag: String, message: String) {
    Log.d(tag, message)
  }

  override fun logVerbose(tag: String, message: String) {
    Log.v(tag, message)
  }

  override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) {
    Log.e(tag, message, e)
  }

  override fun logStackTrace(tag: String, e: Exception) {
    Log.e(tag, e.message, e)
  }
}
