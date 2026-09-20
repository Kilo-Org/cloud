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
import type * as NotificationsModule from '@/lib/notifications';

import { renderActiveAgentsWidget, WIDGET_NAME } from './active-agents-widget';
import { formatGlanceableCount, isWidgetRtl } from './count-format';
import {
  end as endLiveUpdate,
  getPostedNotificationChannel,
  setWidgetSnapshot,
  start as startLiveUpdate,
  update as updateLiveUpdate,
} from './live-update';
import { isNotificationPermissionGranted } from './permission';
import { showAndroidPermissionAlertOnce } from './permission-alert';
import {
  type AndroidWidgetProps,
  buildApproveLabel,
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

/**
 * Create the Android channels before the first post, lazily. `@/lib/notifications`
 * pulls the native notifications graph (expo-notifications → expo-constants),
 * and the importers of this module — the widget / Live-Update headless entry and
 * the pure widget suite — must not load it. The reverse direction already
 * lazy-requires the platform sink registrations (see
 * `ensureGlanceableSinksLoaded`), so this keeps one rule.
 *
 * The dynamic import is memoized so concurrent starts share one load, matching
 * the drafts / encrypted-kv pattern.
 */
let notificationsModule: Promise<typeof NotificationsModule> | null = null;

async function ensureAndroidNotificationChannels(): Promise<void> {
  notificationsModule ??= import('@/lib/notifications');
  const { ensureAndroidNotificationChannels: ensureChannels } = await notificationsModule;
  await ensureChannels();
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

/**
 * A needs-input card is the kind that asks the user a question, so its first
 * entry alerts; a progress card is a silent status update, and a later update
 * inside the same kind must not re-alert.
 */
function shouldAlert(kind: AgentNotificationKind): boolean {
  return kind === 'needs-input' && notificationKind !== 'needs-input';
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

/** The Approve action label for this snapshot, or null when there is none. */
function approveLabelFor(snapshot: GlanceableAgentsSnapshot): string | null {
  return buildApproveLabel(snapshot, translate);
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
  if (notificationActive && snapshot.revision <= revision) {
    return;
  }
  const title = translate(NOTIFICATION_TITLE_KEY);
  const text = buildOngoingNotificationText(snapshot, {}, translate, formatGlanceableCount);
  const openAgentsLabel = translate(OPEN_AGENTS_LABEL_KEY);
  const approveLabel = approveLabelFor(snapshot);
  const compactText = buildCompactNotificationText(snapshot, {}, formatGlanceableCount);
  // The card's kind decides the channel the user can silence and whether this
  // entry alerts; progress stays on the silent status channel.
  const kind = agentNotificationKindForGlanceableSnapshot(snapshot);
  const channelId = androidChannelIdForAgentKind(kind);

  if (notificationActive) {
    updateLiveUpdate(
      title,
      text,
      openAgentsLabel,
      approveLabel,
      compactText,
      channelId,
      shouldAlert(kind)
    );
    notificationKind = kind;
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
    // Android 8+ drops a post whose channel does not exist yet, and the JS side
    // owns channel creation, so the channel is ensured before the first start.
    await ensureAndroidNotificationChannels();
    if (epoch !== startEpoch || !hasCurrentWork(snapshot)) {
      return;
    }
    // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- a concurrent start/retry can set notificationActive while awaiting permission
    if (notificationActive) {
      if (snapshot.revision > revision) {
        updateLiveUpdate(
          title,
          text,
          openAgentsLabel,
          approveLabel,
          compactText,
          channelId,
          shouldAlert(kind)
        );
        notificationKind = kind;
        terminalExpiresAt = null;
        revision = snapshot.revision;
      }
      return;
    }
    startLiveUpdate(
      title,
      text,
      openAgentsLabel,
      approveLabel,
      compactText,
      channelId,
      shouldAlert(kind)
    );
    notificationKind = kind;
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
  const kind = agentNotificationKindForGlanceableSnapshot(p.snapshot);
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
  startLiveUpdate(
    translate(NOTIFICATION_TITLE_KEY),
    buildOngoingNotificationText(p.snapshot, {}, translate, formatGlanceableCount),
    translate(OPEN_AGENTS_LABEL_KEY),
    approveLabelFor(p.snapshot),
    buildCompactNotificationText(p.snapshot, {}, formatGlanceableCount),
    androidChannelIdForAgentKind(kind),
    shouldAlert(kind)
  );
  notificationKind = kind;
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
    await retryPendingStart();
    return;
  }
  showAndroidPermissionAlertOnce();
}

export const androidSink: GlanceableSink = {
  publish(snapshot) {
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
      const kind = agentNotificationKindForGlanceableSnapshot(snapshot);
      updateLiveUpdate(
        translate(NOTIFICATION_TITLE_KEY),
        eligible
          ? buildOngoingNotificationText(snapshot, {}, translate, formatGlanceableCount)
          : (props.statusLine ?? translate('glanceable.empty')),
        translate(OPEN_AGENTS_LABEL_KEY),
        eligible ? approveLabelFor(snapshot) : null,
        eligible ? buildCompactNotificationText(snapshot, {}, formatGlanceableCount) : null,
        androidChannelIdForAgentKind(kind),
        shouldAlert(kind),
        terminalExpiresAt === null ? 0 : Math.max(1, terminalExpiresAt - Date.now())
      );
      notificationKind = kind;
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
  notificationKind = null;
  storedKindAdopted = false;
  revision = 0;
  pending = null;
  startEpoch += 1;
  terminalExpiresAt = null;
}
