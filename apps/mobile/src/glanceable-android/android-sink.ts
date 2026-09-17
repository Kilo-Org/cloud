import {
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { getLiveActivityEnabled } from '@/lib/glanceable/live-activity-switch';
import {
  getGlanceableDelivery,
  type GlanceableSink,
  type GlanceableSinkContext,
} from '@/lib/glanceable/sink-registry';
import { getWaitingAsk, type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import { renderActiveAgentsWidget, WIDGET_NAME } from './active-agents-widget';
import { formatGlanceableCount, isWidgetRtl } from './count-format';
import {
  end as endLiveUpdate,
  getStoredWidgetSnapshot,
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
// i18n-dup-ok: 'glanceable.openSession' repeats the English word of the open-state keys of a pull
// request, a finding and an invoice — a status adjective cs, pl, be and ru decline apart from the
// imperative — and of two feature CTAs the catalogs render as a noun (fr "Ouverture", de "Offen",
// es "Apertura"), so this notification and Live Activity button keeps its own key.
const OPEN_SESSION_LABEL_KEY = 'glanceable.openSession';
const APPROVE_LABEL_KEY = 'common.approve';

/** No recorded ask: Open falls back to the Agents tab, never a guessed session. */
const OPEN_AGENTS_URL = 'kiloapp:///cloud/sessions';

/** The session route the deep link adds an id to. */
const SESSION_URL_PREFIX = 'kiloapp:///cloud/sessions/';

function translate(key: string): string {
  return i18n.t(key);
}

/** The two notification actions, both named by the one recorded waiting ask. */
type NotificationActions = {
  openLabel: string;
  openUrl: string;
  approveLabel: string | null;
};

/**
 * Only a cloud-agent permission ask can be answered headlessly, and only while
 * it is still the recorded ask. The session id goes into the Open intent and
 * nowhere else: never the title, the text, the compact text, or the label.
 */
function notificationActions(): NotificationActions {
  const ask = getWaitingAsk();
  const canApprove = ask?.status === 'permission' && ask.isCloudAgent;
  return {
    openLabel: translate(OPEN_SESSION_LABEL_KEY),
    openUrl: ask === null ? OPEN_AGENTS_URL : `${SESSION_URL_PREFIX}${ask.kiloSessionId}`,
    approveLabel: canApprove ? translate(APPROVE_LABEL_KEY) : null,
  };
}

let lastWidgetSnapshot: GlanceableAgentsSnapshot | null = null;
let notificationActive = false;
let revision = 0;
let pending: {
  snapshot: GlanceableAgentsSnapshot;
  ctx: GlanceableSinkContext;
} | null = null;
let startEpoch = 0;
let terminalExpiresAt: number | null = null;

/**
 * A one-line notice for the next republish: the headless approve task sets it
 * on a retryable failure, the notification text prefixes it, and nothing else
 * reads it. It never outlives its ask — a changed ask or a zero needs-input
 * count clears it — so a failure message cannot describe a new session.
 */
let actionNotice: string | null = null;
let noticeAskKey: string | null = null;

/** The recorded ask identity the notice describes; '' means "no ask". */
function askKey(ask: WaitingAsk | null): string {
  return ask === null ? '' : `${ask.kiloSessionId}|${ask.status}`;
}

/**
 * Set (or clear) the notice for the next republish. Records the ask it belongs
 * to, so the drop rules below can tell a stale notice from a current one.
 */
export function setGlanceableActionNotice(notice: string | null): void {
  actionNotice = notice;
  noticeAskKey = notice === null ? null : askKey(getWaitingAsk());
}

/** Drop the notice once nothing needs input or the recorded ask has changed. */
function pruneActionNotice(snapshot: GlanceableAgentsSnapshot): void {
  if (
    actionNotice !== null &&
    (snapshot.needsInput === 0 || askKey(getWaitingAsk()) !== noticeAskKey)
  ) {
    actionNotice = null;
    noticeAskKey = null;
  }
}

/** The ongoing notification line, carrying the pending notice when one waits. */
function notificationText(snapshot: GlanceableAgentsSnapshot): string {
  pruneActionNotice(snapshot);
  return buildOngoingNotificationText(snapshot, {}, translate, formatGlanceableCount, actionNotice);
}

/** A delayed render must check the current snapshot and its deadline, not cached props. */
export function getCurrentWidgetProps(): AndroidWidgetProps | null {
  return lastWidgetSnapshot === null
    ? null
    : buildCurrentWidgetProps(lastWidgetSnapshot, translate, formatGlanceableCount);
}

function renderWidgetNow(props: AndroidWidgetProps): void {
  void requestWidgetUpdate({
    widgetName: WIDGET_NAME,
    renderWidget: info =>
      renderActiveAgentsWidget(getCurrentWidgetProps() ?? props, info, isWidgetRtl()),
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
  // The in-app switch is checked first: it is the one the user set here, and
  // honoring it costs no native call. The notification permission still decides
  // the rest. The widget is deliberately not gated — placing one is the opt-in.
  if (!getLiveActivityEnabled() || !hasCurrentWork(snapshot)) {
    pending = null;
    return;
  }
  // A pending notice must reach the surface even when the counts did not
  // change: it is the only carrier of the retryable failure, and the republish
  // that carries it can arrive with the same counts (or not arrive at all).
  if (notificationActive && snapshot.revision <= revision && actionNotice === null) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  const text = notificationText(snapshot);
  const actions = notificationActions();
  const compactText = buildCompactNotificationText(snapshot, {}, formatGlanceableCount);

  if (notificationActive) {
    updateLiveUpdate(
      title,
      text,
      actions.openLabel,
      actions.openUrl,
      actions.approveLabel,
      compactText
    );
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
        updateLiveUpdate(
          title,
          text,
          actions.openLabel,
          actions.openUrl,
          actions.approveLabel,
          compactText
        );
        terminalExpiresAt = null;
        revision = snapshot.revision;
      }
      return;
    }
    startLiveUpdate(
      title,
      text,
      actions.openLabel,
      actions.openUrl,
      actions.approveLabel,
      compactText
    );
    notificationActive = true;
    terminalExpiresAt = null;
    revision = snapshot.revision;
    pending = null;
    getGlanceableDelivery().registerTokens(snapshot, ctx.organizationId, ctx.userId);
    return;
  }
  pending = { snapshot, ctx };
}

/**
 * Re-render the surface the app last published, read back from Android's own
 * storage, so a headless tap that cannot reach the backend still shows its
 * pending notice. Reusing `tryStartOrUpdate` keeps the one render path: the
 * in-app switch, the permission gate, the revision bookkeeping, and the
 * notification actions; its start branch re-posts the fixed native id, so the
 * counts stay and only the text gains the notice.
 *
 * Returns when the render is on the notification: the headless task finishes
 * with this promise, so a fire-and-forget update would be lost with the process
 * and the failure line the user's tap produced would never be shown.
 */
export async function renderStoredSnapshotWithNotice(ctx: GlanceableSinkContext): Promise<void> {
  const snapshot = getStoredWidgetSnapshot();
  if (snapshot === null) {
    return;
  }
  await tryStartOrUpdate(snapshot, ctx);
}

/** Retry a pending start after permission turns granted. Caller owns the check. */
function retryPendingStart(): void {
  const p = pending;
  if (
    p === null ||
    notificationActive ||
    !getLiveActivityEnabled() ||
    !hasCurrentWork(p.snapshot)
  ) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  const actions = notificationActions();
  startLiveUpdate(
    title,
    notificationText(p.snapshot),
    actions.openLabel,
    actions.openUrl,
    actions.approveLabel,
    buildCompactNotificationText(p.snapshot, {}, formatGlanceableCount)
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
    // A zero needs-input snapshot ends the ask the notice belongs to.
    pruneActionNotice(snapshot);
    lastWidgetSnapshot = snapshot;
    setWidgetSnapshot(snapshot);
    const props = buildCurrentWidgetProps(snapshot, translate, formatGlanceableCount);
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
      const actions = notificationActions();
      updateLiveUpdate(
        translate(NOTIFICATION_TITLE_KEY),
        eligible ? notificationText(snapshot) : (props.statusLine ?? translate('glanceable.empty')),
        actions.openLabel,
        actions.openUrl,
        actions.approveLabel,
        eligible ? buildCompactNotificationText(snapshot, {}, formatGlanceableCount) : null,
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
  actionNotice = null;
  noticeAskKey = null;
}
