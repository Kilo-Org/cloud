import Foundation

public protocol TerminalSink: AnyObject {
  func onData(_ bytes: Data)

  func onClosed(exitStatus: Int?, error: String?)
}

/// The far end of a terminal screen.
///
/// `write` and `resize` are called on the main thread. Implementations may deliver output from any
/// thread through the sink, the view marshals it back onto the main thread.
public protocol TerminalByteSource: AnyObject {
  func write(_ bytes: Data)

  func resize(cols: Int, rows: Int)

  func setSink(_ sink: TerminalSink?)
}
