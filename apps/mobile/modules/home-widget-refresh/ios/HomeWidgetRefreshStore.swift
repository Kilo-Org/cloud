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
  /// Nil when the app group is unusable; `locked` then skips the work instead of trapping.
  static let defaults = UserDefaults(suiteName: group)
  static let lockURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
    .appendingPathComponent("home-widget-refresh.lock")
  static let accessGroup = Bundle.main.object(forInfoDictionaryKey: "HomeWidgetKeychainAccessGroup") as? String
  static let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    config.timeoutIntervalForResource = 20
    return URLSession(configuration: config, delegate: HomeWidgetNetworkDelegate(), delegateQueue: nil)
  }()
  static var layoutDirection: LayoutDirection {
    let locale = defaults?.string(forKey: "homeWidgetLocale") ?? Locale.current.identifier
    let language = locale.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map(String.init) ?? "en"
    return Locale.characterDirection(forLanguage: language) == .rightToLeft ? .rightToLeft : .leftToRight
  }
  static var keyQuery: [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "context"]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  static func saveJSON(_ defaults: UserDefaults, _ value: Any?, key: String) {
    guard let value, let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    defaults.set(data, forKey: key)
  }
  static func readJSON(_ defaults: UserDefaults, _ key: String) -> [String: Any]? {
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

  /// Runs `body` under the cross-process lock, or returns nil without running it when the
  /// app group's defaults, container or lock file are unavailable (a misprovisioned build).
  @discardableResult
  static func locked<T>(_ body: (UserDefaults) throws -> T) rethrows -> T? {
    guard let defaults, let lockURL else { return nil }
    let fd = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { return nil }
    flock(fd, LOCK_EX)
    defer { flock(fd, LOCK_UN); close(fd) }
    // UserDefaults caches across processes; refresh under the cross-process lock.
    defaults.synchronize()
    return try body(defaults)
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
    let stored: Void? = try locked { defaults in
      let previous = context()
      if previous?["scopeKey"] as? String != config["scopeKey"] as? String ||
         previous?["accountEpoch"] as? Int != config["accountEpoch"] as? Int { clearLocked(defaults) }
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
      saveJSON(defaults, config["data"], key: "homeWidgetData")
      saveJSON(defaults, config["home"], key: "homeWidgetPresentation")
      defaults.set(config["refreshAt"], forKey: "homeWidgetRefreshAt")
      defaults.set(config["locale"], forKey: "homeWidgetLocale")
      defaults.set(max(900, (config["refreshAt"] as? Double ?? 0) / 1000 - Date().timeIntervalSince1970), forKey: "homeWidgetRefreshDelay")
      defaults.synchronize()
    }
    guard stored != nil else {
      throw NSError(domain: service, code: 3, userInfo: [NSLocalizedDescriptionKey: "Widget storage unavailable"])
    }
    WidgetCenter.shared.reloadTimelines(ofKind: widgetName)
  }

  static func clearLocked(_ defaults: UserDefaults) {
    SecItemDelete(keyQuery as CFDictionary)
    defaults.set(UUID().uuidString, forKey: "homeWidgetGeneration")
    for key in ["homeWidgetData", "homeWidgetPresentation", "homeWidgetRefreshAt", "homeWidgetRefreshDelay", "homeWidgetTerminalFence", timelineKey] {
      defaults.removeObject(forKey: key)
    }
    defaults.synchronize()
  }
  static func clear() {
    // Without the group container there is nothing else to clear, but the credential still goes.
    if locked({ clearLocked($0) }) == nil { SecItemDelete(keyQuery as CFDictionary) }
    WidgetCenter.shared.reloadTimelines(ofKind: widgetName)
  }
  static func fixture(_ enabled: Bool) {
    locked { defaults in
      defaults.set(enabled, forKey: "homeWidgetFixture")
      defaults.set(UUID().uuidString, forKey: "homeWidgetGeneration")
      defaults.synchronize()
    }
  }
  /// Fixture capture only: the fixture path never runs `configure`, so the app
  /// mirrors its active language into the same key the widget chrome reads for
  /// its layout direction. Without this the extension would draw a localized
  /// surface inside stale chrome.
  static func fixtureLocale(_ locale: String) {
    locked { defaults in
      defaults.set(locale, forKey: "homeWidgetLocale")
      defaults.synchronize()
    }
  }
  static func current(_ defaults: UserDefaults, _ config: [String: Any], _ generation: String) -> Bool {
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

  /// How long a pressed marker may be carried forward across timeline rebuilds.
  /// Long enough for a cold launch's JavaScript to boot and read it, short
  /// enough that a press from a previous session can never fire. The app
  /// mirrors it as `PENDING_ACTION_TTL_MS`.
  static let pendingActionTTL: Double = 5 * 60 * 1000
  static var timelineKey: String { "__expo_widgets_\(widgetName)_timeline" }

  /// The press marker the stored timeline still carries, if any.
  ///
  /// Only a real press can put one there: the App Intent merges the button's
  /// press patch — `pendingAction`/`pendingApprovalKey` and the `pendingActionAt`
  /// it was pressed at — into the pressed entry's props. This reads the stored
  /// timeline, never the server presentation, so a refresh can never manufacture
  /// a press. A marker carrying no press time (an older patch) falls back to now.
  static func storedPress(_ entries: [[String: Any]]?) -> [String: Any]? {
    for entry in entries ?? [] {
      guard let props = entry["props"] as? [String: Any],
            let action = props["pendingAction"] as? String,
            action == "approve" || action == "new-agent" else { continue }
      var press: [String: Any] = ["action": action]
      if let approvalKey = props["pendingApprovalKey"] as? String { press["approvalKey"] = approvalKey }
      press["at"] = (props["pendingActionAt"] as? Double) ?? Date().timeIntervalSince1970 * 1000
      return press
    }
    return nil
  }

  /// The marker to re-attach to the rebuilt timeline's first entry, or nil when
  /// nothing waits or the recorded press is older than the TTL.
  static func carriedPress(_ entries: [[String: Any]]?) -> [String: Any]? {
    guard let press = storedPress(entries), let at = press["at"] as? Double,
          Date().timeIntervalSince1970 * 1000 - at <= pendingActionTTL else { return nil }
    return press
  }

  static func refresh() async {
    let captured = locked { defaults -> ([String: Any], String)? in
      guard !defaults.bool(forKey: "homeWidgetFixture"), let config = context(),
            let generation = defaults.string(forKey: "homeWidgetGeneration") else { return nil }
      return (config, generation)
    } ?? nil
    guard let (config, generation) = captured,
          let request = request(config) else { return }
    do {
      let (bytes, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { return }
      // Only an authentication refusal is terminal; 403 and every other failure keep retained content.
      if http.statusCode == 401 {
        locked { defaults in
          if current(defaults, config, generation) {
            clearLocked(defaults)
            defaults.set(["scopeKey": config["scopeKey"]!, "accountEpoch": config["accountEpoch"]!], forKey: "homeWidgetTerminalFence")
            let copy = config["copy"] as? [String: String] ?? [:]
            defaults.set([["timestamp": Int(Date().timeIntervalSince1970 * 1000),
              "props": ["statusLine": copy["privacy"] ?? "", "countLines": [], "primaryCount": 0,
                "actions": ["approve": false, "newAgent": false]]]], forKey: timelineKey)
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
      locked { defaults in
        guard current(defaults, config, generation) else { return }
        let oldSnapshot = readJSON(defaults, "homeWidgetData")?["snapshot"] as? [String: Any]
        if let oldAt = oldSnapshot?["updatedAt"] as? String, let newAt = snapshot["updatedAt"] as? String, newAt < oldAt { return }
        saveJSON(defaults, ["snapshot": snapshot, "details": details], key: "homeWidgetData")
        saveJSON(defaults, home, key: "homeWidgetPresentation")
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
        // Read the marker before the rebuild: the entries below are built from
        // the server presentation and the stored base props, and the marker is
        // re-attached from this carried press alone while it is still fresh.
        let stored = defaults.array(forKey: timelineKey) as? [[String: Any]]
        let carried = carriedPress(stored)
        let baseProps = (stored?.first?["props"] as? [String: Any]) ?? [:]
        var entries = phases.compactMap { phase -> [String: Any]? in
          guard let at = phase["at"] as? Double, let presentation = phase["home"] as? [String: Any] else { return nil }
          var props = baseProps
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
          props["actionFeedback"] = nil
          props["accessibilityLabel"] = counts.map { "\($0["count"] ?? 0) \(copy[$0["kind"] as? String ?? ""] ?? "")" }.joined(separator: ", ")
          // The rebuild owns the marker: strip every copy so only the carried
          // press below can put one back on the first entry while it is fresh.
          props.removeValue(forKey: "pendingAction")
          props.removeValue(forKey: "pendingApprovalKey")
          props.removeValue(forKey: "pendingActionAt")
          // JSON nulls aren't valid property-list values; expo-widgets omits them too.
          return ["timestamp": Int(at), "props": propertyList(props)]
        }
        if !entries.isEmpty {
          if let carried, var props = entries[0]["props"] as? [String: Any] {
            props["pendingAction"] = carried["action"]
            if let approvalKey = carried["approvalKey"] { props["pendingApprovalKey"] = approvalKey }
            props["pendingActionAt"] = carried["at"]
            entries[0]["props"] = props
          }
          defaults.set(entries, forKey: timelineKey)
        }
        defaults.synchronize()
      }
    } catch {
      // Keep the confirmed cache and its checkedAt on every transport/parse failure.
    }
  }

  static func registerStoredPushToken() async {
    guard let token = locked({ $0.string(forKey: "homeWidgetPushToken") }) ?? nil else { return }
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
    locked { defaults in defaults.set(hex, forKey: "homeWidgetPushToken"); defaults.synchronize() }
    await uploadPushToken(hex, enabled: widgets.contains(where: { $0.kind == widgetName }))
  }

  static func uploadPushToken(_ token: String, enabled: Bool) async {
    let captured = locked { defaults -> ([String: Any], String)? in
      guard !defaults.bool(forKey: "homeWidgetFixture"), let config = context(),
            let generation = defaults.string(forKey: "homeWidgetGeneration") else { return nil }
      return (config, generation)
    } ?? nil
    guard let (config, generation) = captured,
          locked({ current($0, config, generation) }) == true,
          let request = request(config, input: ["token": token, "enabled": enabled]) else { return }
    _ = try? await session.data(for: request)
    if locked({ current($0, config, generation) }) != true {
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
