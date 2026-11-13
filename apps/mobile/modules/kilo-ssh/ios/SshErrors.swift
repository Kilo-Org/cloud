import ExpoModulesCore

/**
 * Hands a Rust failure to JavaScript with the core's error category as `code`.
 *
 * The cases are the generated variants of `SshError`, so this switch stays
 * exhaustive.
 */
extension SshError {
  var category: String {
    switch self {
    case .Network:
      return "Network"
    case .Timeout:
      return "Timeout"
    case .HostKeyRejected:
      return "HostKeyRejected"
    case .AuthFailed:
      return "AuthFailed"
    case .AuthCancelled:
      return "AuthCancelled"
    case .UnsupportedAlgorithm:
      return "UnsupportedAlgorithm"
    case .KeyParse:
      return "KeyParse"
    case .WrongPassphrase:
      return "WrongPassphrase"
    case .InvalidExport:
      return "InvalidExport"
    case .ChannelClosed:
      return "ChannelClosed"
    case .Protocol:
      return "Protocol"
    case .KeyGeneration:
      return "KeyGeneration"
    case .NotFound:
      return "NotFound"
    case .PermissionDenied:
      return "PermissionDenied"
    case .Cancelled:
      return "Cancelled"
    case .Forwarding:
      return "Forwarding"
    case .LocalIo:
      return "LocalIo"
    }
  }

  var detail: String {
    switch self {
    case .Network(let message),
      .Timeout(let message),
      .AuthFailed(let message),
      .UnsupportedAlgorithm(let message),
      .KeyParse(let message),
      .InvalidExport(let message),
      .ChannelClosed(let message),
      .Protocol(let message),
      .KeyGeneration(let message),
      .Forwarding(let message),
      .LocalIo(let message):
      return message
    case .NotFound(let path), .PermissionDenied(let path):
      return path
    case .HostKeyRejected:
      return "The host key was rejected"
    case .AuthCancelled:
      return "Authentication was cancelled"
    case .WrongPassphrase:
      return "Wrong or missing passphrase"
    case .Cancelled:
      return "The transfer was cancelled"
    }
  }

  var codedException: Exception {
    Exception(name: "SshError", description: detail, code: category)
  }
}
