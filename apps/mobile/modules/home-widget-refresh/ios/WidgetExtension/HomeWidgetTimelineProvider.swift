import Foundation
import WidgetKit
internal import ExpoWidgets

struct HomeWidgetTimelineProvider: TimelineProvider {
  let name: String
  private var base: WidgetsTimelineProvider { WidgetsTimelineProvider(name: name) }
  func placeholder(in context: Context) -> WidgetsTimelineEntry { base.placeholder(in: context) }
  func getSnapshot(in context: Context, completion: @escaping @Sendable (WidgetsTimelineEntry) -> Void) {
    base.getSnapshot(in: context, completion: completion)
  }
  func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<WidgetsTimelineEntry>) -> Void) {
    Task {
      await HomeWidgetRefreshStore.refresh()
      base.getTimeline(in: context) { timeline in
        let next = HomeWidgetRefreshStore.locked { defaults -> Double? in
          guard !defaults.bool(forKey: "homeWidgetFixture"),
                HomeWidgetRefreshStore.context() != nil else { return nil }
          return defaults.double(forKey: "homeWidgetRefreshAt")
        } ?? nil
        guard let next else {
          completion(Timeline(entries: timeline.entries, policy: .never))
          return
        }
        // WidgetKit budgets requests; the requested wake is not an exact alarm.
        let now = Date().timeIntervalSince1970
        let retryDelay = HomeWidgetRefreshStore.locked { $0.double(forKey: "homeWidgetRefreshDelay") } ?? 0
        let wake = Date(timeIntervalSince1970: next / 1000 > now ? max(now + 900, next / 1000) : now + max(900, retryDelay))
        completion(Timeline(entries: timeline.entries, policy: .after(wake)))
      }
    }
  }
}

@available(iOS 26.0, *)
struct HomeWidgetPushHandler: WidgetPushHandler {
  func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
    Task { await HomeWidgetRefreshStore.pushToken(pushInfo.token, widgets: widgets) }
  }
}
