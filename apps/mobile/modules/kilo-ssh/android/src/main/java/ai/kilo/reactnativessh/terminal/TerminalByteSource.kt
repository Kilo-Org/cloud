package ai.kilo.reactnativessh.terminal

/**
 * The far end of a terminal screen.
 *
 * [write] and [resize] are called on the main thread. Implementations may emit or send output from any
 * thread through the sink, the view marshals it back onto the main thread.
 */
interface TerminalByteSource {

  fun write(bytes: ByteArray)

  fun resize(cols: Int, rows: Int)

  fun setSink(sink: TerminalSink?)
}
