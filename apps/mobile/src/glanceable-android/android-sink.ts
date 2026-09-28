import {
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isStartableGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  type AgentNotificationKind,
  agentNotificationKindForAndroidChannelId,
  agentNotificationKindForGlanceableSnapshot,
  androidChannelIdForAgentKind,
} from '@kilocode/notifications';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { getLiveActivityEnabled } from '@/lib/glanceable/live-activity-switch';
import {
  getGlanceableDelivery,
  type GlanceableSink,
  type GlanceableSinkContext,
} from '@/lib/glanceable/sink-registry';
import { getWaitingAsk } from '@/lib/glanceable/waiting-ask';

import { getActionNotice, pruneActionNotice, setGlanceableActionNotice } from './action-notice';
import { renderActiveAgentsWidget, WIDGET_NAME } from './active-agents-widget';
import { formatGlanceableAgo, formatGlanceableCount, isWidgetRtl } from './count-format';
import { ensureAndroidNotificationChannels } from './ensure-notification-channels';
import {
  buildNotificationActions,
  end as endLiveUpdate,
  getPostedNotificationChannel,
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

// Re-exported because the approve task and the widget suite import it from the
// sink; the notice state itself now lives in `./action-notice`.
export { setGlanceableActionNotice };

/**
 * Android owns the widget expiry and notification timeout. The sink supplies
 * translated copy, persists the latest snapshot, and fences pending starts.
 * Ending the ongoing notification never cancels a still-eligible widget expiry.
 */
const NOTIFICATION_TITLE_KEY = 'glanceable.channelName';

function translate(key: string): string {
  return i18n.t(key);
}

let lastWidgetSnapshot: GlanceableAgentsSnapshot | null = null;
let notificationActive = false;
let revision = 0;
/**
 * The kind the posted card carries, so entering needs-input is detectable: only
 * the first entry alerts, and repeated updates of an unchanged kind stay quiet.
 * A JS restart empties this memory while the native card stays in the shade, so
 * the first publication of a fresh process adopts the kind the durable native
 * mirror recorded (see `publish`).
 */
let notificationKind: AgentNotificationKind | null = null;
// One adoption per JS process: the native mirror is overwritten by the first
// publication, so later publications cannot read the previous process's kind.
let storedKindAdopted = false;
let pending: {
  snapshot: GlanceableAgentsSnapshot;
  ctx: GlanceableSinkContext;
} | null = null;
let startEpoch = 0;
let terminalExpiresAt: number | null = null;

/** The ongoing notification line, carrying the pending notice when one waits. */
function notificationText(snapshot: GlanceableAgentsSnapshot): string {
  pruneActionNotice(snapshot);
  return buildOngoingNotificationText(
    snapshot,
    {},
    translate,
    formatGlanceableCount,
    getActionNotice()
  );
}

/**
 * A needs-input card is the kind that asks the user a question, so its first
 * entry alerts; a progress card is a silent status update, and a later update
 * inside the same kind must not re-alert.
 */
function shouldAlert(kind: AgentNotificationKind): boolean {
  return kind === 'needs-input' && notificationKind !== 'needs-input';
}

/** Keep action fields and kind bookkeeping identical on every native post path. */
function postNotification(
  snapshot: GlanceableAgentsSnapshot,
  method: 'start' | 'update',
  terminalText?: string
): void {
  const actions = buildNotificationActions(getWaitingAsk(), translate);
  const kind = agentNotificationKindForGlanceableSnapshot(snapshot);
  const args = [
    translate(NOTIFICATION_TITLE_KEY),
    terminalText ?? notificationText(snapshot),
    actions.openLabel,
    actions.openUrl,
    // A terminal card has nothing to answer, even if a background delivery left
    // an ask recorded. Open remains the route back; Approve must disappear.
    terminalText === undefined ? actions.approveLabel : null,
    terminalText === undefined
      ? buildCompactNotificationText(snapshot, {}, formatGlanceableCount)
      : null,
    androidChannelIdForAgentKind(kind),
    shouldAlert(kind),
  ] as const;
  if (method === 'start') {
    startLiveUpdate(...args);
  } else {
    const timeoutMs =
      terminalText === undefined || terminalExpiresAt === null
        ? 0
        : Math.max(1, terminalExpiresAt - Date.now());
    updateLiveUpdate(...args, timeoutMs);
  }
  notificationKind = kind;
  revision = snapshot.revision;
}

/** A delayed render must check the current snapshot and its deadline, not cached props. */
export function getCurrentWidgetProps(): AndroidWidgetProps | null {
  return lastWidgetSnapshot === null
    ? null
    : buildCurrentWidgetProps(
        lastWidgetSnapshot,
        translate,
        formatGlanceableCount,
        formatGlanceableAgo
      );
}

function renderWidgetNow(props: AndroidWidgetProps): void {
  void requestWidgetUpdate({
    widgetName: WIDGET_NAME,
    renderWidget: info =>
      renderActiveAgentsWidget(getCurrentWidgetProps() ?? props, info, isWidgetRtl()),
  });
}

/**
 * The ongoing card exists only while an agent is working or waiting on the
 * user. Idle-only work is not worth a status notification: nothing is
 * happening, and an ongoing card has no opt-in the way a placed home-screen
 * widget does. The widget keeps showing the idle counts; the card ends, and a
 * later startable snapshot raises a new one.
 */
function hasCurrentWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return (
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    isStartableGlanceableWork(snapshot) &&
    Date.parse(snapshot.expiresAt) > Date.now()
  );
}

function endNotification(): void {
  endLiveUpdate();
  notificationActive = false;
  notificationKind = null;
  revision = 0;
  pending = null;
  startEpoch += 1;
  terminalExpiresAt = null;
}

/**
 * Start the ongoing notification once permission is granted. Permission-denied
 * emits record the latest eligible snapshot so a later gesture can restart it.
 *
 * `carryNotice` marks the stored-notice render (`renderStoredSnapshotWithNotice`),
 * which must reach a card still in the shade even after the snapshot's
 * `expiresAt`: an eligible card is posted ongoing with no native deadline, so its
 * Approve can be tapped past the expiry, and the failure line that tap draws must
 * not be gated on `hasCurrentWork`.
 */
async function tryStartOrUpdate(
  snapshot: GlanceableAgentsSnapshot,
  ctx: GlanceableSinkContext,
  options: { carryNotice?: boolean } = {}
): Promise<void> {
  const carryNotice = options.carryNotice === true;
  // The in-app switch is checked first: it is the one the user set here, and
  // honoring it costs no native call. The notification permission still decides
  // the rest. The widget is deliberately not gated — placing one is the opt-in.
  if (!getLiveActivityEnabled() || (!carryNotice && !hasCurrentWork(snapshot))) {
    pending = null;
    return;
  }
  // A pending notice must reach the surface even when the counts did not
  // change: it is the only carrier of the retryable failure, and the republish
  // that carries it can arrive with the same counts (or not arrive at all).
  if (notificationActive && snapshot.revision <= revision && getActionNotice() === null) {
    return;
  }
  if (notificationActive) {
    postNotification(snapshot, 'update');
    terminalExpiresAt = null;
    return;
  }

  const epoch = startEpoch;
  const granted = await isNotificationPermissionGranted();
  if (epoch !== startEpoch || (!carryNotice && !hasCurrentWork(snapshot))) {
    return;
  }
  if (granted) {
    // Android 8+ drops a post whose channel does not exist yet, and the JS side
    // owns channel creation, so the channel is ensured before the first start.
    await ensureAndroidNotificationChannels();
    if (epoch !== startEpoch || (!carryNotice && !hasCurrentWork(snapshot))) {
      return;
    }
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- a concurrent start/retry can set notificationActive while awaiting permission
    if (notificationActive) {
      if (snapshot.revision > revision) {
        postNotification(snapshot, 'update');
        terminalExpiresAt = null;
      }
      return;
    }
    postNotification(snapshot, 'start');
    notificationActive = true;
    terminalExpiresAt = null;
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
 * The card is posted ongoing with no native deadline, so it can still be in the
 * shade with its Approve action after the stored snapshot's `expiresAt`; the
 * `carryNotice` render therefore ignores that deadline and draws the notice on
 * the card the user tapped.
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
  await tryStartOrUpdate(snapshot, ctx, { carryNotice: true });
}

/** Retry a pending start after permission turns granted. Caller owns the check. */
async function retryPendingStart(): Promise<void> {
  const p = pending;
  if (
    p === null ||
    notificationActive ||
    !getLiveActivityEnabled() ||
    !hasCurrentWork(p.snapshot)
  ) {
    return;
  }
  // Same fence as the first start: the channel must exist before the post.
  const epoch = startEpoch;
  await ensureAndroidNotificationChannels();
  if (
    epoch !== startEpoch ||
    pending !== p ||
    !getLiveActivityEnabled() ||
    !hasCurrentWork(p.snapshot)
  ) {
    return;
  }
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- a concurrent start/update can post while awaiting the channel
  if (notificationActive) {
    return;
  }
  postNotification(p.snapshot, 'start');
  notificationActive = true;
  terminalExpiresAt = null;
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
    await retryPendingStart();
    return;
  }
  showAndroidPermissionAlertOnce();
}

export const androidSink: GlanceableSink = {
  publish(snapshot) {
    // A zero needs-input snapshot ends the ask the notice belongs to.
    pruneActionNotice(snapshot);
    lastWidgetSnapshot = snapshot;
    // The native card survives a JS restart. Read the durable posted-channel
    // marker before it is overwritten and adopt the kind it recorded, so a
    // needs-input card that is already in the shade does not alert again on the
    // fresh process. The marker (not the widget snapshot, which is stored
    // whether or not a card was posted) is what proves the card still exists:
    // permission denial, a failed start, or a dismissed card leaves no marker,
    // so the first real needs-input post still alerts.
    if (!storedKindAdopted) {
      storedKindAdopted = true;
      if (!notificationActive) {
        const storedKind = agentNotificationKindForAndroidChannelId(getPostedNotificationChannel());
        if (storedKind !== null) {
          notificationKind = storedKind;
        }
      }
    }
    setWidgetSnapshot(snapshot);
    const props = buildCurrentWidgetProps(
      snapshot,
      translate,
      formatGlanceableCount,
      formatGlanceableAgo
    );
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
      postNotification(
        snapshot,
        'update',
        eligible ? undefined : (props.statusLine ?? translate('glanceable.empty'))
      );
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
  notificationKind = null;
  storedKindAdopted = false;
  revision = 0;
  pending = null;
  startEpoch += 1;
  terminalExpiresAt = null;
  setGlanceableActionNotice(null);
}
