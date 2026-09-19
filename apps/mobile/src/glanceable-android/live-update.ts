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
  isDndAccessGranted(): boolean;
  start(
    title: string,
    text: string,
    openAgentsLabel: string,
    approveLabel: string | null,
    compactText: string | null,
    channelId: AndroidNotificationChannelId,
    alerting: boolean,
    promotion: boolean
  ): void;
  update(
    title: string,
    text: string,
    openAgentsLabel: string,
    approveLabel: string | null,
    compactText: string | null,
    channelId: AndroidNotificationChannelId,
    alerting: boolean,
    timeoutMs: number
  ): void;
  end(): void;
  setWidgetSnapshot(snapshot: string, expiresAt: number): void;
  getWidgetSnapshot(): string | null;
  getPostedChannel(): string | null;
};

const nativeModule = requireOptionalNativeModule<LiveUpdateNativeModule>('ActiveAgentsLiveUpdate');

/**
 * API 36.1+ promotion capability: SDK_INT_FULL >= 36_001_000 and
 * NotificationManager.canPostPromotedNotifications(). Mirrors the native gate.
 */
function isPromotionCapable(): boolean {
  return nativeModule?.isPromotionCapable() ?? false;
}

/**
 * Whether the user still grants this app Do Not Disturb access — the system
 * settings row that lets the needs-input card break through Do Not Disturb.
 * Null when the native module is absent (iOS, or a build older than the query),
 * where the app keeps asking for the override and lets the framework decide.
 */
export function getDndAccessGranted(): boolean | null {
  return nativeModule?.isDndAccessGranted() ?? null;
}

// eslint-disable-next-line max-params -- mirrors the native presentation fields
export function start(
  title: string,
  text: string,
  openAgentsLabel: string,
  approveLabel: string | null,
  compactText: string | null,
  channelId: AndroidNotificationChannelId,
  alerting: boolean
): void {
  nativeModule?.start(
    title,
    text,
    openAgentsLabel,
    approveLabel,
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
  approveLabel: string | null,
  compactText: string | null,
  channelId: AndroidNotificationChannelId,
  alerting: boolean,
  timeoutMs = 0
): void {
  // The native `update` spends its eighth bridge slot on the terminal timeout,
  // which is Expo's argument limit for a native `Function`, so it reads the
  // promotion gate from its own `isPromotionCapable()` instead of a JS flag.
  nativeModule?.update(
    title,
    text,
    openAgentsLabel,
    approveLabel,
    compactText,
    channelId,
    alerting,
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

/**
 * The channel the native module last posted the fixed ongoing notification on,
 * or null when no card is posted. The module writes the marker only after a
 * successful post and clears it on dismiss, so it — not the widget snapshot,
 * which is stored whether or not a card was posted — proves the card exists.
 */
export function getPostedNotificationChannel(): string | null {
  return nativeModule?.getPostedChannel() ?? null;
}
