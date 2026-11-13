import ExpoModulesCore

/**
 * Payloads the module hands to JavaScript.
 *
 * Incoming values are Expo records; outgoing ones are plain structs with the
 * same shape as the Kotlin records, because `sendEvent` takes a dictionary.
 */
struct ConnectConfigRecord: Record, @unchecked Sendable {
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var username: String = ""
  @Field var auth: AuthRecord = AuthRecord()
  @Field var appSessionId: String = ""
  @Field var connectTimeoutMs: Int = 15_000
  @Field var keepaliveIntervalS: Int = 15
}

struct AuthRecord: Record, @unchecked Sendable {
  @Field var type: String = ""
  @Field var password: String?
  @Field var privateKeyOpenssh: String?
  @Field var passphrase: String?
}

struct ShellOptionsRecord: Record, @unchecked Sendable {
  @Field var term: String = "xterm-256color"
  @Field var cols: Int = 80
  @Field var rows: Int = 24
}

struct GeneratedKeyRecord: Record, @unchecked Sendable {
  @Field var privateKeyOpenssh: String = ""
  @Field var publicKeyOpenssh: String = ""
  @Field var fingerprintSha256: String = ""
}

struct ParsedKeyRecord: Record, @unchecked Sendable {
  @Field var algorithm: String = ""
  @Field var publicKeyOpenssh: String = ""
  @Field var fingerprintSha256: String = ""
  @Field var encrypted: Bool = false
}

struct ExecOutputRecord: Record, @unchecked Sendable {
  @Field var stdout: String = ""
  @Field var stderr: String = ""
  @Field var exitStatus: Int?
}

struct SftpEntryRecord: Record, @unchecked Sendable {
  @Field var name: String = ""
  @Field var kind: String = ""
  @Field var size: Double = 0
  @Field var modifiedUnix: Double?
  @Field var permissions: Int?
}

extension EntryKind {
  var recordName: String {
    switch self {
    case .file:
      return "file"
    case .directory:
      return "directory"
    case .symlink:
      return "symlink"
    case .other:
      return "other"
    }
  }
}

func sftpEntryRecord(_ entry: Entry) -> SftpEntryRecord {
  var record = SftpEntryRecord()
  record.name = entry.name
  record.kind = entry.kind.recordName
  record.size = Double(entry.size)
  record.modifiedUnix = entry.modifiedUnix.map(Double.init)
  record.permissions = entry.permissions.map { Int($0) }
  return record
}

struct ForwardConfigRecord: Record, @unchecked Sendable {
  @Field var bindHost: String = "127.0.0.1"
  @Field var bindPort: Int = 0
  @Field var destHost: String = ""
  @Field var destPort: Int = 22
}

struct ForwardStartRecord: Record, @unchecked Sendable {
  @Field var forwardId: String = ""
  @Field var port: Int = 0
}

/// A live session as the registry holds it, for a runtime that just started.
struct SessionInfoRecord: Record, @unchecked Sendable {
  @Field var sessionId: String = ""
  @Field var appSessionId: String = ""
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var username: String = ""
  @Field var shellIds: [String] = []
  @Field var sftpIds: [String] = []
  @Field var forwardIds: [String] = []
}

/// A live forward as the registry holds it.
struct ForwardInfoRecord: Record, @unchecked Sendable {
  @Field var forwardId: String = ""
  @Field var sessionId: String = ""
  @Field var direction: String = ""
  @Field var bindHost: String = ""
  @Field var bindPort: Int = 0
  @Field var port: Int = 0
}

struct HostKeyRequest: Sendable {
  let sessionId: String
  let requestId: String
  let host: String
  let port: Int
  let algorithm: String
  let publicKeyBase64: String
  let fingerprintSha256: String

  func toEvent() -> [String: Any?] {
    [
      "sessionId": sessionId,
      "requestId": requestId,
      "host": host,
      "port": port,
      "algorithm": algorithm,
      "publicKeyBase64": publicKeyBase64,
      "fingerprintSha256": fingerprintSha256
    ]
  }
}

struct PromptPayload: Sendable {
  let text: String
  let echo: Bool

  func toEvent() -> [String: Any?] {
    ["text": text, "echo": echo]
  }
}

struct KeyboardInteractiveRequest: Sendable {
  let sessionId: String
  let requestId: String
  let name: String
  let instructions: String
  let prompts: [PromptPayload]

  func toEvent() -> [String: Any?] {
    [
      "sessionId": sessionId,
      "requestId": requestId,
      "name": name,
      "instructions": instructions,
      "prompts": prompts.map { $0.toEvent() }
    ]
  }
}

struct DisconnectNotice: Sendable {
  let sessionId: String
  let reason: String

  func toEvent() -> [String: Any?] {
    ["sessionId": sessionId, "reason": reason]
  }
}
