package ai.kilo.reactnativessh.terminal

import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class TerminalTheme : Record {

  @Field
  var foreground: Int = DEFAULT_FOREGROUND

  @Field
  var background: Int = DEFAULT_BACKGROUND

  @Field
  var cursor: Int = DEFAULT_CURSOR

  @Field
  var selection: Int = DEFAULT_SELECTION

  @Field
  var ansi: List<Int> = DEFAULT_ANSI

  fun applyTo(emulator: TerminalEmulator) {
    val colors = emulator.mColors.mCurrentColors
    colors[TextStyle.COLOR_INDEX_FOREGROUND] = foreground
    colors[TextStyle.COLOR_INDEX_BACKGROUND] = background
    colors[TextStyle.COLOR_INDEX_CURSOR] = cursor
    ansi.take(16).forEachIndexed { index, color -> colors[index] = color }
  }

  companion object {
    const val DEFAULT_FOREGROUND = 0xFFD8DEE9.toInt()
    const val DEFAULT_BACKGROUND = 0xFF101418.toInt()
    const val DEFAULT_CURSOR = 0xFFD8DEE9.toInt()
    const val DEFAULT_SELECTION = 0x553B82C4

    val DEFAULT_ANSI = listOf(
      0xFF1B2027.toInt(),
      0xFFD06A6A.toInt(),
      0xFF8FBF7F.toInt(),
      0xFFD6B36A.toInt(),
      0xFF6C9FD8.toInt(),
      0xFFB48EAD.toInt(),
      0xFF6FB6BF.toInt(),
      0xFFC3C9D4.toInt(),
      0xFF5A6472.toInt(),
      0xFFE08A8A.toInt(),
      0xFFA8D49A.toInt(),
      0xFFE7CB88.toInt(),
      0xFF8AB8E8.toInt(),
      0xFFC9A6CD.toInt(),
      0xFF8FD0D8.toInt(),
      0xFFF0F3F7.toInt(),
    )
  }
}
