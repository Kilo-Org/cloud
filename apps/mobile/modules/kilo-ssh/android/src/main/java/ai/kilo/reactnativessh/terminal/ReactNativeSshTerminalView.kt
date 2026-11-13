package ai.kilo.reactnativessh.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup.LayoutParams
import android.view.inputmethod.InputMethodManager
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalTransport
import com.termux.view.TerminalView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.roundToInt

class ReactNativeSshTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  internal val terminal = TerminalView(context, null)

  private val mainHandler = Handler(Looper.getMainLooper())
  private val sourceListener: () -> Unit = { rebindSource() }

  private var sourceId: String? = null
  private var source: TerminalByteSource? = null
  private var fontSizePx = dpSize(DEFAULT_FONT_SIZE_DP)
  private var theme = TerminalTheme()
  private var appliedColumns = 0
  private var appliedRows = 0
  private var scaleAccumulator = 1f
  private var transportClosed = false
  private var autoFocus = false

  internal var cursorStyleValue: Int = TerminalEmulator.DEFAULT_TERMINAL_CURSOR_STYLE

  private val sink = object : TerminalSink {
    override fun onData(bytes: ByteArray) {
      mainHandler.post { session.appendOutput(bytes, 0, bytes.size) }
    }

    override fun onClosed(exitStatus: Int?, error: String?) {
      mainHandler.post {
        // One transport closes once: the notice and the event are skipped for
        // every later close report, and a rebound source starts a new cycle.
        if (transportClosed) return@post
        transportClosed = true
        updateFocus()
        session.notifyTransportClosed(exitStatus ?: 0, error)
        TerminalViewEvents.emit(this@ReactNativeSshTerminalView, "onClosed", Bundle().apply {
          putInt("exitStatus", exitStatus ?: 0)
          putString("error", error)
        })
      }
    }
  }

  private val transport = object : TerminalTransport {
    override fun write(data: ByteArray, offset: Int, count: Int) {
      // A closed transport stays closed until a new source is bound: later writes
      // are dropped here, because the close notice and event already went out.
      if (transportClosed) return
      val target = source
      if (target == null) {
        sink.onClosed(null, "terminal source '${sourceId.orEmpty()}' is not bound")
        return
      }
      val bytes = if (offset == 0 && count == data.size) data else data.copyOfRange(offset, offset + count)
      target.write(bytes)
    }

    override fun resize(columns: Int, rows: Int) {
      source?.resize(columns, rows)
    }

    override fun close() {
      source?.setSink(null)
    }
  }

  private var session: TerminalSession = TerminalSession(
    transport,
    TerminalSessionClientBridge(this),
    TRANSCRIPT_ROWS,
  )

  init {
    terminal.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    terminal.isFocusable = true
    terminal.isFocusableInTouchMode = true
    descendantFocusability = android.view.ViewGroup.FOCUS_AFTER_DESCENDANTS
    terminal.setTerminalViewClient(TerminalViewClientBridge(this))
    addView(terminal)
    terminal.setTextSize(fontSizePx)
    terminal.setBackgroundColor(theme.background)
    terminal.setSelectionColor(theme.selection)
    terminal.attachSession(session)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    TerminalSourceRegistry.addListener(sourceListener)
    rebindSource()
    updateFocus()
  }

  override fun onDetachedFromWindow() {
    TerminalSourceRegistry.removeListener(sourceListener)
    source?.setSink(null)
    source = null
    updateFocus()
    super.onDetachedFromWindow()
  }

  fun bindSource(sourceId: String?) {
    this.sourceId = sourceId
    rebindSource()
  }

  fun applyAutoFocus(value: Boolean) {
    if (autoFocus == value) return
    autoFocus = value
    updateFocus()
  }

  fun applyFontFamily(fontFamily: String?) {
    terminal.setTypeface(resolveTypeface(fontFamily))
  }

  fun applyFontSize(fontSizeDp: Double) {
    fontSizePx = dpSize(fontSizeDp.coerceIn(MIN_FONT_SIZE_DP, MAX_FONT_SIZE_DP))
    terminal.setTextSize(fontSizePx)
  }

  fun applyTheme(theme: TerminalTheme) {
    this.theme = theme
    terminal.setBackgroundColor(theme.background)
    terminal.setSelectionColor(theme.selection)
    session.emulator?.let { theme.applyTo(it) }
    terminal.invalidate()
  }

  fun applyCursorStyle(cursorStyle: String) {
    cursorStyleValue = when (cursorStyle) {
      "bar" -> TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR
      "underline" -> TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE
      else -> TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
    }
    session.emulator?.setCursorStyle()
    terminal.invalidate()
  }

  fun sendInput(base64: String) {
    onMain {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      session.write(bytes, 0, bytes.size)
    }
  }

  fun sendText(text: String) {
    onMain {
      session.write(text)
    }
  }

  fun copySelection() {
    onMain {
      val text = terminal.getSelectedText()?.trim().orEmpty()
      if (text.isEmpty()) return@onMain
      copyToClipboard(text)
      terminal.stopTextSelectionMode()
    }
  }

  fun scrollToBottom() {
    onMain {
      terminal.setTopRow(0)
      terminal.invalidate()
    }
  }

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
  }

  internal fun onEmulatorReady() {
    val emulator = session.emulator ?: return
    theme.applyTo(emulator)
    emulator.setCursorStyle()
    terminal.invalidate()

    if (emulator.mColumns != appliedColumns || emulator.mRows != appliedRows) {
      appliedColumns = emulator.mColumns
      appliedRows = emulator.mRows
      TerminalViewEvents.emit(this, "onResize", Bundle().apply {
        putInt("cols", appliedColumns)
        putInt("rows", appliedRows)
      })
    }
  }

  internal fun onScreenUpdated() {
    terminal.onScreenUpdated()
  }

  internal fun onScaleGesture(scale: Float): Float {
    scaleAccumulator *= scale
    when {
      scaleAccumulator >= ZOOM_STEP -> changeFontSize(1)
      scaleAccumulator <= 1f / ZOOM_STEP -> changeFontSize(-1)
    }
    return 1f
  }

  internal fun handleSingleTap(event: MotionEvent) {
    val emulator = session.emulator
    if (emulator != null) {
      val cell = terminal.getColumnAndRow(event, true)
      val line = emulator.screen.getSelectedText(0, cell[1], emulator.mColumns - 1, cell[1])
      val url = UrlDetector.find(line, cell[0])
      if (url != null) {
        TerminalViewEvents.emit(this, "onLinkPress", Bundle().apply { putString("url", url) })
        return
      }
    }
    requestTerminalFocus()
  }

  internal fun handleMetaKey(event: KeyEvent, session: TerminalSession): Boolean {
    if (!event.isMetaPressed) return false
    val codePoint = event.getUnicodeChar(event.metaState and KeyEvent.META_CTRL_MASK.inv())
    if (codePoint == 0) return false
    session.writeCodePoint(true, codePoint)
    return true
  }

  internal fun emitSelectionChange(selecting: Boolean) {
    TerminalViewEvents.emit(this, "onSelectionChange", Bundle().apply { putBoolean("selecting", selecting) })
  }

  internal fun emitTitleChange(title: String?) {
    TerminalViewEvents.emit(this, "onTitleChange", Bundle().apply { putString("title", title) })
  }

  internal fun emitBell() {
    TerminalViewEvents.emit(this, "onBell")
  }

  internal fun copyToClipboard(text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("terminal", text))
  }

  internal fun pasteFromClipboard() {
    onMain {
      val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return@onMain
      val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
      if (text.isEmpty()) return@onMain
      session.write(text)
    }
  }

  private fun rebindSource() {
    val next = sourceId?.let { TerminalSourceRegistry.find(it) }
    if (next === source) return

    source?.setSink(null)
    source = next
    next?.setSink(sink)

    if (next != null && transportClosed) {
      transportClosed = false
      session = TerminalSession(transport, TerminalSessionClientBridge(this), TRANSCRIPT_ROWS)
      terminal.attachSession(session)
      appliedColumns = 0
      appliedRows = 0
    }

    val emulator = session.emulator
    if (next != null && emulator != null) next.resize(emulator.mColumns, emulator.mRows)
    updateFocus()
  }

  private fun changeFontSize(deltaDp: Int) {
    val currentDp = (fontSizePx / density()).roundToInt()
    val nextDp = (currentDp + deltaDp).coerceIn(MIN_FONT_SIZE_DP.toInt(), MAX_FONT_SIZE_DP.toInt())
    if (nextDp == currentDp) return

    fontSizePx = dpSize(nextDp.toDouble())
    terminal.setTextSize(fontSizePx)
    TerminalViewEvents.emit(this, "onFontSizeChange", Bundle().apply { putInt("fontSize", nextDp) })
    scaleAccumulator = 1f
  }

  private fun updateFocus() {
    val accepting = canAcceptInput()
    terminal.isFocusable = accepting
    terminal.isFocusableInTouchMode = accepting
    if (autoFocus && accepting) requestTerminalFocus() else clearTerminalFocus()
  }

  private fun canAcceptInput(): Boolean = source != null && !transportClosed

  internal fun requestTerminalFocus() {
    onMain {
      if (!canAcceptInput() || !isAttachedToWindow) return@onMain
      terminal.requestFocus()
      terminal.post {
        if (!canAcceptInput() || !terminal.isFocused) return@post
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(terminal, 0)
      }
    }
  }

  internal fun clearTerminalFocus() {
    onMain {
      terminal.clearFocus()
      context.getSystemService(InputMethodManager::class.java)
        ?.hideSoftInputFromWindow(terminal.windowToken, 0)
    }
  }

  private fun resolveTypeface(fontFamily: String?): Typeface {
    if (fontFamily.isNullOrEmpty()) return Typeface.MONOSPACE
    return try {
      Typeface.createFromAsset(context.assets, "fonts/$fontFamily.ttf")
    } catch (cause: RuntimeException) {
      Typeface.create(fontFamily, Typeface.NORMAL)
    }
  }

  private fun density(): Float = resources.displayMetrics.density

  private fun dpSize(dp: Double): Int = (dp * density()).roundToInt()

  private companion object {
    const val TRANSCRIPT_ROWS = 10_000
    const val DEFAULT_FONT_SIZE_DP = 13.0
    const val MIN_FONT_SIZE_DP = 7.0
    const val MAX_FONT_SIZE_DP = 36.0
    const val ZOOM_STEP = 1.15f
  }
}
