import {
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { i18n } from '@/i18n';
import {
  getGlanceableDelivery,
  type GlanceableSink,
  type GlanceableSinkContext,
} from '@/lib/glanceable/sink-registry';

import { renderActiveAgentsWidget, WIDGET_NAME } from './active-agents-widget';
import {
  end as endLiveUpdate,
  setWidgetSnapshot,
  start as startLiveUpdate,
  update as updateLiveUpdate,
} from './live-update';
import { isNotificationPermissionGranted } from './permission';
import { showAndroidPermissionAlertOnce } from './permission-alert';
import {
  type AndroidWidgetProps,
  buildCompactNotificationText,
  buildCurrentWidgetProps,
  buildOngoingNotificationText,
} from './widget-props';

/**
 * Android owns the widget expiry and notification timeout. The sink supplies
 * translated copy, persists the latest snapshot, and fences pending starts.
 * Ending the ongoing notification never cancels a still-eligible widget expiry.
 */
const NOTIFICATION_TITLE_KEY = 'glanceable.channelName';
const OPEN_AGENTS_LABEL_KEY = 'glanceable.openAgents';

function translate(key: string): string {
  return i18n.t(key);
}

let lastWidgetSnapshot: GlanceableAgentsSnapshot | null = null;
let notificationActive = false;
let revision = 0;
let pending: { snapshot: GlanceableAgentsSnapshot; ctx: GlanceableSinkContext } | null = null;
let startEpoch = 0;
let terminalExpiresAt: number | null = null;

/** A delayed render must check the current snapshot and its deadline, not cached props. */
export function getCurrentWidgetProps(): AndroidWidgetProps | null {
  return lastWidgetSnapshot === null
    ? null
    : buildCurrentWidgetProps(lastWidgetSnapshot, translate);
}

function renderWidgetNow(props: AndroidWidgetProps): void {
  void requestWidgetUpdate({
    widgetName: WIDGET_NAME,
    renderWidget: info => renderActiveAgentsWidget(getCurrentWidgetProps() ?? props, info),
  });
}

function hasCurrentWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return (
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    isEligibleGlanceableWork(snapshot) &&
    Date.parse(snapshot.expiresAt) > Date.now()
  );
}

function endNotification(): void {
  endLiveUpdate();
  notificationActive = false;
  revision = 0;
  pending = null;
  startEpoch += 1;
  terminalExpiresAt = null;
}

/**
 * Start the ongoing notification once permission is granted. Permission-denied
 * emits record the latest eligible snapshot so a later gesture can restart it.
 */
async function tryStartOrUpdate(
  snapshot: GlanceableAgentsSnapshot,
  ctx: GlanceableSinkContext
): Promise<void> {
  if (!hasCurrentWork(snapshot)) {
    pending = null;
    return;
  }
  if (notificationActive && snapshot.revision <= revision) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  const text = buildOngoingNotificationText(snapshot, {}, translate);
  const openAgentsLabel = translate(OPEN_AGENTS_LABEL_KEY);
  const compactText = buildCompactNotificationText(snapshot, {});

  if (notificationActive) {
    updateLiveUpdate(title, text, openAgentsLabel, compactText);
    terminalExpiresAt = null;
    revision = snapshot.revision;
    return;
  }

  const epoch = startEpoch;
  const granted = await isNotificationPermissionGranted();
  if (epoch !== startEpoch || !hasCurrentWork(snapshot)) {
    return;
  }
  if (granted) {
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- a concurrent start/retry can set notificationActive while awaiting permission
    if (notificationActive) {
      if (snapshot.revision > revision) {
        updateLiveUpdate(title, text, openAgentsLabel, compactText);
        terminalExpiresAt = null;
        revision = snapshot.revision;
      }
      return;
    }
    startLiveUpdate(title, text, openAgentsLabel, compactText);
    notificationActive = true;
    terminalExpiresAt = null;
    revision = snapshot.revision;
    pending = null;
    getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId);
    return;
  }
  pending = { snapshot, ctx };
}

/** Retry a pending start after permission turns granted. Caller owns the check. */
function retryPendingStart(): void {
  const p = pending;
  if (p === null || notificationActive || !hasCurrentWork(p.snapshot)) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  startLiveUpdate(
    title,
    buildOngoingNotificationText(p.snapshot, {}, translate),
    translate(OPEN_AGENTS_LABEL_KEY),
    buildCompactNotificationText(p.snapshot, {})
  );
  notificationActive = true;
  terminalExpiresAt = null;
  revision = p.snapshot.revision;
  pending = null;
  getGlanceableDelivery().registerTokens(p.snapshot, p.ctx.organizationId, p.ctx.userId);
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
    lastWidgetSnapshot = snapshot;
    setWidgetSnapshot(snapshot);
    const props = buildCurrentWidgetProps(snapshot, translate);
    renderWidgetNow(props);
    const eligible = hasCurrentWork(snapshot);
    if (eligible) {
      terminalExpiresAt = null;
    } else {
      pending = null;
      startEpoch += 1;
      if (
        snapshot.status === 'privacy' ||
        snapshot.status === 'signed_out' ||
        !notificationActive
      ) {
        // Also dismiss the fixed native id after a JS restart, without starting an empty ongoing.
        endNotification();
        return;
      }
      terminalExpiresAt ??= Date.now() + GLANCEABLE_TERMINAL_MS;
      if (terminalExpiresAt <= Date.now()) {
        endNotification();
        return;
      }
    }
    if (notificationActive && snapshot.revision > revision) {
      updateLiveUpdate(
        translate(NOTIFICATION_TITLE_KEY),
        eligible
          ? buildOngoingNotificationText(snapshot, {}, translate)
          : (props.statusLine ?? translate('glanceable.empty')),
        translate(OPEN_AGENTS_LABEL_KEY),
        eligible ? buildCompactNotificationText(snapshot, {}) : null,
        terminalExpiresAt === null ? 0 : Math.max(1, terminalExpiresAt - Date.now())
      );
      revision = snapshot.revision;
    }
  },

  startOrUpdate(snapshot, ctx) {
    void tryStartOrUpdate(snapshot, ctx);
  },

  endImmediate() {
    // The scope subscription also delivers widget updates while no work is active.
    endNotification();
  },
};

/** Test-only: drop JS state without touching Android-owned storage or deadlines. */
export function _resetAndroidSinkForTests(): void {
  lastWidgetSnapshot = null;
  notificationActive = false;
  revision = 0;
  pending = null;
  startEpoch += 1;
  terminalExpiresAt = null;
}
