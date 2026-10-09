import Foundation
import Security
import WidgetKit
import SwiftUI
import Darwin

// Compiled into both the app pod and widget target. JWT/context never enter UserDefaults.
enum HomeWidgetRefreshStore {
  static let widgetName = "ActiveAgentsWidget"
  static let service = "com.kilocode.home-widget-refresh"
  static let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String ?? "group.com.kilocode.kiloapp"
  static let defaults = UserDefaults(suiteName: group)!
  static let accessGroup = Bundle.main.object(forInfoDictionaryKey: "HomeWidgetKeychainAccessGroup") as? String
  static let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    config.timeoutIntervalForResource = 20
    return URLSession(configuration: config, delegate: HomeWidgetNetworkDelegate(), delegateQueue: nil)
  }()
  static var layoutDirection: LayoutDirection {
    let locale = defaults.string(forKey: "homeWidgetLocale") ?? Locale.current.identifier
    let language = locale.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map(String.init) ?? "en"
    return Locale.characterDirection(forLanguage: language) == .rightToLeft ? .rightToLeft : .leftToRight
  }
  static var keyQuery: [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "context"]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  static func saveJSON(_ value: Any?, key: String) {
    guard let value, let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    defaults.set(data, forKey: key)
  }
  static func readJSON(_ key: String) -> [String: Any]? {
    guard let bytes = defaults.data(forKey: key) else { return nil }
    return (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
  }
  static func propertyList(_ value: Any) -> Any {
    if let dictionary = value as? [String: Any] {
      return dictionary.filter { !($0.value is NSNull) }.mapValues { propertyList($0) }
    }
    if let array = value as? [Any] { return array.filter { !($0 is NSNull) }.map { propertyList($0) } }
    return value
  }

  static func locked<T>(_ body: () throws -> T) rethrows -> T {
    let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)!
      .appendingPathComponent("home-widget-refresh.lock")
    let fd = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    precondition(fd >= 0, "Cannot lock widget state")
    flock(fd, LOCK_EX)
    defer { flock(fd, LOCK_UN); close(fd) }
    // UserDefaults caches across processes; refresh under the cross-process lock.
    defaults.synchronize()
    return try body()
  }

  static func context() -> [String: Any]? {
    var query = keyQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func configure(_ config: [String: Any]) throws {
    try locked {
      let previous = context()
      if previous?["scopeKey"] as? String != config["scopeKey"] as? String ||
         previous?["accountEpoch"] as? Int != config["accountEpoch"] as? Int { clearLocked() }
      let data = try JSONSerialization.data(withJSONObject: config)
      var query = keyQuery
      query[kSecValueData as String] = data
      query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemDelete(keyQuery as CFDictionary)
      guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
        throw NSError(domain: service, code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot protect widget authentication"])
      }
      defaults.set(UUID().uuidString, forKey: "homeWidgetGeneration")
      defaults.removeObject(forKey: "homeWidgetTerminalFence")
      saveJSON(config["data"], key: "homeWidgetData")
      saveJSON(config["home"], key: "homeWidgetPresentation")
      defaults.set(config["refreshAt"], forKey: "homeWidgetRefreshAt")
      defaults.set(config["locale"], forKey: "homeWidgetLocale")
      defaults.set(max(900, (config["refreshAt"] as? Double ?? 0) / 1000 - Date().timeIntervalSince1970), forKey: "homeWidgetRefreshDelay")
      defaults.synchronize()
    }
    WidgetCenter.shared.reloadTimelines(ofKind: widgetName)
  }

  static func clearLocked() {
    SecItemDelete(keyQuery as CFDictionary)
    defaults.set(UUID().uuidString, forKey: "homeWidgetGeneration")
    for key in ["homeWidgetData", "homeWidgetPresentation", "homeWidgetRefreshAt", "homeWidgetRefreshDelay", "homeWidgetTerminalFence", "__expo_widgets_\(widgetName)_timeline"] {
      defaults.removeObject(forKey: key)
    }
    defaults.synchronize()
  }
  static func clear() { locked { clearLocked() }; WidgetCenter.shared.reloadTimelines(ofKind: widgetName) }
  static func fixture(_ enabled: Bool) {
    locked {
      defaults.set(enabled, forKey: "homeWidgetFixture")
      defaults.set(UUID().uuidString, forKey: "homeWidgetGeneration")
      defaults.synchronize()
    }
  }
  static func current(_ config: [String: Any], _ generation: String) -> Bool {
    guard !defaults.bool(forKey: "homeWidgetFixture"),
          defaults.string(forKey: "homeWidgetGeneration") == generation,
          let latest = context() ?? defaults.dictionary(forKey: "homeWidgetTerminalFence") else { return false }
    return latest["scopeKey"] as? String == config["scopeKey"] as? String &&
      latest["accountEpoch"] as? Int == config["accountEpoch"] as? Int
  }
  static func request(_ config: [String: Any], input: [String: Any]? = nil) -> URLRequest? {
    guard let endpoint = config["endpoint"] as? String, let token = config["token"] as? String,
          var components = URLComponents(string: endpoint),
          components.scheme == "https" || components.host == "localhost" || components.host == "127.0.0.1" else { return nil }
    if input != nil {
      components.path = "/api/mobile/widgets/push-token"
      components.query = nil
    }
    guard let url = components.url else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = input == nil ? "GET" : "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let input { request.httpBody = try? JSONSerialization.data(withJSONObject: input) }
    return request
  }

  static func refresh() async {
    let captured: ([String: Any], String)? = locked {
      guard !defaults.bool(forKey: "homeWidgetFixture"), let config = context(),
            let generation = defaults.string(forKey: "homeWidgetGeneration") else { return nil }
      return (config, generation)
    }
    guard let (config, generation) = captured,
          let request = request(config) else { return }
    do {
      let (bytes, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { return }
      // Only an authentication refusal is terminal; 403 and every other failure keep retained content.
      if http.statusCode == 401 {
        locked {
          if current(config, generation) {
            clearLocked()
            defaults.set(["scopeKey": config["scopeKey"]!, "accountEpoch": config["accountEpoch"]!], forKey: "homeWidgetTerminalFence")
            let copy = config["copy"] as? [String: String] ?? [:]
            defaults.set([["timestamp": Int(Date().timeIntervalSince1970 * 1000),
              "props": ["statusLine": copy["privacy"] ?? "", "countLines": [], "primaryCount": 0,
                "actions": ["approve": false, "newAgent": false]]]], forKey: "__expo_widgets_\(widgetName)_timeline")
            defaults.synchronize()
          }
        }
        return
      }
      guard http.statusCode == 200, bytes.count <= 262_144,
            let payload = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            let snapshot = payload["snapshot"] as? [String: Any],
            snapshot["scopeKey"] as? String == config["scopeKey"] as? String,
            let details = payload["details"] as? [String: Any],
            let home = payload["home"] as? [String: Any],
            let refreshAt = payload["refreshAt"] as? Double else { return }
      locked {
        guard current(config, generation) else { return }
        let oldSnapshot = readJSON("homeWidgetData")?["snapshot"] as? [String: Any]
        if let oldAt = oldSnapshot?["updatedAt"] as? String, let newAt = snapshot["updatedAt"] as? String, newAt < oldAt { return }
        saveJSON(["snapshot": snapshot, "details": details], key: "homeWidgetData")
        saveJSON(home, key: "homeWidgetPresentation")
        defaults.set(refreshAt, forKey: "homeWidgetRefreshAt")
        defaults.set(max(900, refreshAt / 1000 - Date().timeIntervalSince1970), forKey: "homeWidgetRefreshDelay")
        let copy = config["copy"] as? [String: String] ?? [:]
        var phases = payload["presentationTimeline"] as? [[String: Any]] ?? [["at": Date().timeIntervalSince1970 * 1000, "home": home]]
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expires = (snapshot["expiresAt"] as? String).flatMap { formatter.date(from: $0) }.map { $0.timeIntervalSince1970 * 1000 }
        if let expires, expires > Date().timeIntervalSince1970 * 1000 {
          let retained = phases.last?["home"] as? [String: Any] ?? home
          phases.append(["at": expires, "home": retained])
          phases.sort { ($0["at"] as? Double ?? 0) < ($1["at"] as? Double ?? 0) }
        }
        let entries = phases.compactMap { phase -> [String: Any]? in
          guard let at = phase["at"] as? Double, let presentation = phase["home"] as? [String: Any] else { return nil }
          var props = (defaults.array(forKey: "__expo_widgets_\(widgetName)_timeline")?.first as? [String: Any])?["props"] as? [String: Any] ?? [:]
          props["home"] = presentation
          var counts = presentation["secondaryCounts"] as? [[String: Any]] ?? []
          if let kind = presentation["primaryKind"] as? String, let count = presentation["primaryCount"] as? Int, count > 0 {
            counts.insert(["kind": kind, "count": count], at: 0)
          }
          props["countLines"] = counts.map { count -> [String: Any] in
            var line = count
            line["label"] = copy[count["kind"] as? String ?? ""] ?? ""
            return line
          }
          props["primaryKind"] = presentation["primaryKind"]
          props["primaryCount"] = presentation["primaryCount"]
          props["primaryLabel"] = copy[presentation["primaryKind"] as? String ?? ""]
          let status = presentation["status"] as? String ?? "waiting"
          props["statusLine"] = status == "content" ? nil : copy[status]
          if let expires, at >= expires {
            props["countLines"] = []
            props["primaryKind"] = nil
            props["primaryCount"] = 0
            props["primaryLabel"] = nil
            props["statusLine"] = copy["expired"]
          }
          props["actions"] = ["approve": presentation["canApprove"] as? Bool ?? false, "newAgent": presentation["canCreate"] as? Bool ?? false]
          props["needsInputSince"] = snapshot["needsInputSince"]
          props["scheduledAt"] = presentation["scheduledAt"]
          props["newestTitle"] = nil
          props["actionLine"] = nil
          props["accessibilityLabel"] = counts.map { "\($0["count"] ?? 0) \(copy[$0["kind"] as? String ?? ""] ?? "")" }.joined(separator: ", ")
          props.removeValue(forKey: "pendingAction")
          // JSON nulls aren't valid property-list values; expo-widgets omits them too.
          return ["timestamp": Int(at), "props": propertyList(props)]
        }
        if !entries.isEmpty { defaults.set(entries, forKey: "__expo_widgets_\(widgetName)_timeline") }
        defaults.synchronize()
      }
    } catch {
      // Keep the confirmed cache and its checkedAt on every transport/parse failure.
    }
  }

  static func registerStoredPushToken() async {
    guard let token = locked({ defaults.string(forKey: "homeWidgetPushToken") }) else { return }
    let widgets: [WidgetInfo]? = await withCheckedContinuation { continuation in
      WidgetCenter.shared.getCurrentConfigurations { result in
        continuation.resume(returning: try? result.get())
      }
    }
    guard let widgets else { return }
    await uploadPushToken(token, enabled: widgets.contains(where: { $0.kind == widgetName }))
  }

  static func pushToken(_ token: Data, widgets: [WidgetInfo]) async {
    let hex = token.map { String(format: "%02x", $0) }.joined()
    locked { defaults.set(hex, forKey: "homeWidgetPushToken"); defaults.synchronize() }
    await uploadPushToken(hex, enabled: widgets.contains(where: { $0.kind == widgetName }))
  }

  static func uploadPushToken(_ token: String, enabled: Bool) async {
    let captured: ([String: Any], String)? = locked {
      guard !defaults.bool(forKey: "homeWidgetFixture"), let config = context(),
            let generation = defaults.string(forKey: "homeWidgetGeneration") else { return nil }
      return (config, generation)
    }
    guard let (config, generation) = captured,
          locked({ current(config, generation) }),
          let request = request(config, input: ["token": token, "enabled": enabled]) else { return }
    _ = try? await session.data(for: request)
    if !locked({ current(config, generation) }) {
      // A completed older upload cannot leave the current installation bound to its former scope.
      await registerStoredPushToken()
    }
  }

  /// Best-effort unregister before explicit clear. Bounded so sign-out isolation is never held hostage by the network.
  static func unregisterPushToken(_ token: String, config: [String: Any]) async {
    guard let request = request(config, input: ["token": token, "enabled": false]) else { return }
    await withTaskGroup(of: Void.self) { group in
      group.addTask { _ = try? await session.data(for: request) }
      group.addTask { try? await Task.sleep(nanoseconds: 3_000_000_000) }
      await group.next()
      group.cancelAll()
    }
  }
}

private final class HomeWidgetNetworkDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    // Credentials are scoped to the configured origin; redirects aren't an authentication recovery path.
    completionHandler(nil)
  }
}
