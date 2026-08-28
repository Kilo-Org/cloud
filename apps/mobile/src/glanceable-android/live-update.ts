import { requireOptionalNativeModule } from 'expo';

/**
 * JS wrapper over the local `ActiveAgentsLiveUpdate` native module. The native
 * side owns the notification id, the channel, and the promotion gate; the JS
 * side owns the translated copy and the revision guard (see android-sink).
 */

type LiveUpdateNativeModule = {
  isPromotionCapable(): boolean;
  start(
    title: string,
    text: string,
    openAgentsLabel: string,
    compactText: string | null,
    promotion: boolean
  ): void;
  update(
    title: string,
    text: string,
    openAgentsLabel: string,
    compactText: string | null,
    promotion: boolean
  ): void;
  end(): void;
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
  compactText: string | null
): void {
  nativeModule?.start(title, text, openAgentsLabel, compactText, isPromotionCapable());
}

// eslint-disable-next-line max-params -- mirrors the native presentation fields
export function update(
  title: string,
  text: string,
  openAgentsLabel: string,
  compactText: string | null
): void {
  nativeModule?.update(title, text, openAgentsLabel, compactText, isPromotionCapable());
}

export function end(): void {
  nativeModule?.end();
}
