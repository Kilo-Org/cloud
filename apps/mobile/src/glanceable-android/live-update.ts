import { requireOptionalNativeModule } from 'expo';

/**
 * JS wrapper over the local `ActiveAgentsLiveUpdate` native module. The native
 * side owns the notification id, the channel, and the promotion gate; the JS
 * side owns the translated copy and the revision guard (see android-sink).
 */

export type LiveUpdateNativeModule = {
  isPromotionCapable(): boolean;
  start(title: string, text: string, promotion: boolean): void;
  update(title: string, text: string, promotion: boolean): void;
  end(): void;
};

const nativeModule = requireOptionalNativeModule<LiveUpdateNativeModule>('ActiveAgentsLiveUpdate');

/**
 * API 36.1+ promotion capability: SDK_INT_FULL >= 36_001_000 and
 * NotificationManager.canPostPromotedNotifications(). Mirrors the native gate.
 */
export function isPromotionCapable(): boolean {
  return nativeModule?.isPromotionCapable() ?? false;
}

export function start(title: string, text: string): void {
  nativeModule?.start(title, text, isPromotionCapable());
}

export function update(title: string, text: string): void {
  nativeModule?.update(title, text, isPromotionCapable());
}

export function end(): void {
  nativeModule?.end();
}
