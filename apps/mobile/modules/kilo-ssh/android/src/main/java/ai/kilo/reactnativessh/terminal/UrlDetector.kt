package ai.kilo.reactnativessh.terminal

internal object UrlDetector {

  private val PATTERN = Regex("""https?://[^\s"'<>\[\]{}|\\^`]+""")
  private const val TRAILING_PUNCTUATION = ".,:;)]}!"

  fun find(line: String, column: Int): String? =
    PATTERN.findAll(line)
      .firstOrNull { column in it.range }
      ?.value
      ?.trimEnd(*TRAILING_PUNCTUATION.toCharArray())
      ?.takeIf { it.length > "https://".length }
}
