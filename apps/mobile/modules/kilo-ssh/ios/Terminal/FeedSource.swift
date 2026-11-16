import ExpoModulesCore
import Foundation

public final class FeedSource: SharedObject, TerminalByteSource {
  let id = UUID().uuidString

  private weak var sink: TerminalSink?

  public override init() {
    super.init()
    TerminalSourceRegistry.shared.register(id, self)
  }

  public func write(_ bytes: Data) {
    emit(event: "onInput", payload: bytes)
  }

  public func resize(cols: Int, rows: Int) {
    emit(event: "onResize", payload: ["cols": cols, "rows": rows])
  }

  public func setSink(_ sink: TerminalSink?) {
    self.sink = sink
  }

  public func feed(_ bytes: Data) {
    DispatchQueue.main.async { [weak self] in
      self?.sink?.onData(bytes)
    }
  }

  public func close(exitStatus: Int?, error: String?) {
    DispatchQueue.main.async { [weak self] in
      self?.sink?.onClosed(exitStatus: exitStatus, error: error)
    }
  }

  public override func sharedObjectDidRelease() {
    TerminalSourceRegistry.shared.unregister(id)
    super.sharedObjectDidRelease()
  }
}
