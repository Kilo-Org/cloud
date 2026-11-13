import Foundation

public final class TransferProgressSink: TransferProgress, @unchecked Sendable {
  private let transferId: String
  private let emit: (String, [String: Any?]) -> Void

  public init(transferId: String, emit: @escaping (String, [String: Any?]) -> Void) {
    self.transferId = transferId
    self.emit = emit
  }

  public func onProgress(transferred: UInt64, total: UInt64?) {
    emit("onTransferProgress", [
      "transferId": transferId,
      "transferred": Double(transferred),
      "total": total.map(Double.init),
    ])
  }
}

public final class ForwardErrorSink: ForwardSink, @unchecked Sendable {
  private let sessionId: String
  private let emit: (String, [String: Any?]) -> Void

  public init(sessionId: String, emit: @escaping (String, [String: Any?]) -> Void) {
    self.sessionId = sessionId
    self.emit = emit
  }

  public func onError(message: String) {
    emit("onForwardError", ["sessionId": sessionId, "message": message])
  }
}
