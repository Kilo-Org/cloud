package ai.kilo.reactnativessh.terminal

/** Receives the bytes and the close signal of a [TerminalByteSource]. */
interface TerminalSink {

  fun onData(bytes: ByteArray)

  fun onClosed(exitStatus: Int?, error: String?)
}
