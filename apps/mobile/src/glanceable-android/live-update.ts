import {
  type GlanceableAgentsSnapshot,
  glanceableAgentsSnapshotSchema,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type AndroidNotificationChannelId } from '@kilocode/notifications';
import { requireOptionalNativeModule } from 'expo';

/**
 * JS wrapper over the local `ActiveAgentsLiveUpdate` native module. The native
 * side owns the notification id and the promotion gate; the JS side owns the
 * translated copy, the notification kind's channel, the alert decision, and the
 * revision guard (see android-sink). Channel creation stays on the JS side too:
 * `ensureAndroidNotificationChannels` in `@/lib/notifications` owns the names,
 * importance, and Do Not Disturb override.
 */

type LiveUpdateNativeModule = {
  isPromotionCapable(): boolean;
  start(
    title: string,
    text: string,
    openAgentsLabel: string,
    compactText: string | null,
    channelId: AndroidNotificationChannelId,
    alerting: boolean,
    promotion: boolean
  ): void;
  update(
    title: string,
    text: string,
    openAgentsLabel: string,
    compactText: string | null,
    channelId: AndroidNotificationChannelId,
    alerting: boolean,
    promotion: boolean,
    timeoutMs: number
  ): void;
  end(): void;
  setWidgetSnapshot(snapshot: string, expiresAt: number): void;
  getWidgetSnapshot(): string | null;
};

const nativeModule = requireOptionalNativeModule<LiveUpdateNativeModule>('ActiveAgentsLiveUpdate');

/**
 * API 36.1+ promotion capability: SDK_INT_FULL >= 36_001_000 and
 * NotificationManager.canPostPromotedNotifications(). Mirrors the native gate.
 */
function isPromotionCapable(): boolean {
  return nativeModule?.isPromotionCapable() ?? false;
}

// eslint-disable-next-line max-params -- mirrors the native presentation fields
export function start(
  title: string,
  text: string,
  openAgentsLabel: string,
  compactText: string | null,
  channelId: AndroidNotificationChannelId,
  alerting: boolean
): void {
  nativeModule?.start(
    title,
    text,
    openAgentsLabel,
    compactText,
    channelId,
    alerting,
    isPromotionCapable()
  );
}

// eslint-disable-next-line max-params -- translated bridge fields plus the native terminal timeout
export function update(
  title: string,
  text: string,
  openAgentsLabel: string,
  compactText: string | null,
  channelId: AndroidNotificationChannelId,
  alerting: boolean,
  timeoutMs = 0
): void {
  nativeModule?.update(
    title,
    text,
    openAgentsLabel,
    compactText,
    channelId,
    alerting,
    isPromotionCapable(),
    timeoutMs
  );
}

export function end(): void {
  nativeModule?.end();
}

/** Persist before rendering; the native receiver owns the single future expiry. */
export function setWidgetSnapshot(snapshot: GlanceableAgentsSnapshot): void {
  const expiresAt = Date.parse(snapshot.expiresAt);
  const needsExpiry =
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    isEligibleGlanceableWork(snapshot) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now();
  nativeModule?.setWidgetSnapshot(JSON.stringify(snapshot), needsExpiry ? expiresAt : 0);
}

/** Native storage is authoritative even when an obsolete headless task was already queued. */
export function getStoredWidgetSnapshot(): GlanceableAgentsSnapshot | null {
  const raw = nativeModule?.getWidgetSnapshot();
  if (raw == null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = glanceableAgentsSnapshotSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
