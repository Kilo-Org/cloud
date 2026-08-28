import {
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { type GlanceableSink, type GlanceableSinkContext } from '@/lib/glanceable/sink-registry';

import { renderActiveAgentsWidget, WIDGET_NAME } from './active-agents-widget';
import {
  end as endLiveUpdate,
  start as startLiveUpdate,
  update as updateLiveUpdate,
} from './live-update';
import { isNotificationPermissionGranted } from './permission';
import { showAndroidPermissionAlertOnce } from './permission-alert';
import {
  type AndroidWidgetProps,
  buildAndroidWidgetProps,
  buildCompactNotificationText,
  buildExpiredWidgetProps,
  buildOngoingNotificationText,
} from './widget-props';

/**
 * Android sink: one ongoing notification plus the resizable Home widget. The
 * widget renders from the last published snapshot; the notification starts on
 * the first eligible emit (after a permission check) and updates one fixed id.
 * Ended notifications never clear the widget so the Home surface stays truthful.
 */

type TimerHandle = ReturnType<typeof setTimeout>;

const NOTIFICATION_TITLE_KEY = 'glanceable.channelName';

function translate(key: string): string {
  return i18n.t(key);
}

let lastWidgetProps: AndroidWidgetProps | null = null;
let notificationActive = false;
let revision = 0;
let pending: { snapshot: GlanceableAgentsSnapshot; ctx: GlanceableSinkContext } | null = null;
let expiryTimer: TimerHandle | null = null;
let startEpoch = 0;

/** The last published widget props; the task handler renders a fresh redraw from it. */
export function getCurrentWidgetProps(): AndroidWidgetProps | null {
  return lastWidgetProps;
}

function renderWidgetNow(props: AndroidWidgetProps): void {
  void requestWidgetUpdate({
    widgetName: WIDGET_NAME,
    renderWidget: info => renderActiveAgentsWidget(props, info),
  });
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

/** One future redraw at expiresAt (no per-minute timer) that hides the counts. */
function scheduleExpiryRedraw(snapshot: GlanceableAgentsSnapshot): void {
  clearExpiryTimer();
  const delay = Date.parse(snapshot.expiresAt) - Date.now();
  if (delay <= 0) {
    return;
  }
  const expiredProps = buildExpiredWidgetProps(snapshot, translate);
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    lastWidgetProps = expiredProps;
    renderWidgetNow(expiredProps);
  }, delay);
}

/**
 * Start the ongoing notification once permission is granted. Permission-denied
 * emits record the latest eligible snapshot so a later gesture can restart it.
 */
async function tryStartOrUpdate(
  snapshot: GlanceableAgentsSnapshot,
  ctx: GlanceableSinkContext
): Promise<void> {
  if (!isEligibleGlanceableWork(snapshot)) {
    pending = null;
    return;
  }
  if (notificationActive && snapshot.revision <= revision) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  const text = buildOngoingNotificationText(snapshot, {}, translate);
  const compactText = buildCompactNotificationText(snapshot, {});

  if (notificationActive) {
    updateLiveUpdate(title, text, compactText);
    revision = snapshot.revision;
    return;
  }

  const epoch = startEpoch;
  const granted = await isNotificationPermissionGranted();
  if (epoch !== startEpoch) {
    return;
  }
  if (granted) {
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- a concurrent start/retry can set notificationActive while awaiting permission
    if (notificationActive) {
      if (snapshot.revision > revision) {
        updateLiveUpdate(title, text, compactText);
        revision = snapshot.revision;
      }
      return;
    }
    startLiveUpdate(title, text, compactText);
    notificationActive = true;
    revision = snapshot.revision;
    pending = null;
    return;
  }
  pending = { snapshot, ctx };
}

/** Retry a pending start after permission turns granted. Caller owns the check. */
function retryPendingStart(): void {
  const p = pending;
  if (p === null || notificationActive || !isEligibleGlanceableWork(p.snapshot)) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  startLiveUpdate(
    title,
    buildOngoingNotificationText(p.snapshot, {}, translate),
    buildCompactNotificationText(p.snapshot, {})
  );
  notificationActive = true;
  revision = p.snapshot.revision;
  pending = null;
}

/**
 * App foreground: when the ongoing cannot start (denied) and work is pending,
 * show the Open Settings alert once. When permission is granted, start at once.
 * The alert needs a foreground Activity, so this never runs on the headless path.
 */
export async function handleAppStateActive(): Promise<void> {
  if (pending === null) {
    return;
  }
  if (await isNotificationPermissionGranted()) {
    retryPendingStart();
    return;
  }
  showAndroidPermissionAlertOnce();
}

export const androidSink: GlanceableSink = {
  publish(snapshot) {
    const props = buildAndroidWidgetProps(snapshot, {}, translate);
    lastWidgetProps = props;
    renderWidgetNow(props);
    scheduleExpiryRedraw(snapshot);
    if (!isEligibleGlanceableWork(snapshot)) {
      pending = null;
      if (!notificationActive) {
        // Dismiss a leftover native notification from a previous process. `end`
        // cancels the fixed id, which is a no-op when nothing is posted.
        endLiveUpdate();
      }
    }
    // Mirror the newest revision onto an already-started notification so the
    // empty/stale/privacy copy shows during the terminal window before end.
    if (notificationActive && snapshot.revision > revision) {
      updateLiveUpdate(
        translate(NOTIFICATION_TITLE_KEY),
        buildOngoingNotificationText(snapshot, {}, translate),
        buildCompactNotificationText(snapshot, {})
      );
      revision = snapshot.revision;
    }
  },

  startOrUpdate(snapshot, ctx) {
    void tryStartOrUpdate(snapshot, ctx);
  },

  endImmediate() {
    clearExpiryTimer();
    endLiveUpdate();
    notificationActive = false;
    revision = 0;
    pending = null;
    startEpoch += 1;
    // Widget props intentionally kept: the Home widget stays truthful.
  },
};

/** Test-only: drop all sink state between cases. */
export function _resetAndroidSinkForTests(): void {
  lastWidgetProps = null;
  notificationActive = false;
  revision = 0;
  pending = null;
  startEpoch += 1;
  clearExpiryTimer();
}
