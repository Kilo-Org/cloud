import * as Application from 'expo-application';
import * as Device from 'expo-device';
import PostHog from 'posthog-react-native';
import { useCallback, useSyncExternalStore } from 'react';

import { POSTHOG_API_KEY } from '@/lib/config';

/**
 * Product analytics events. Same PostHog project as the web app, so
 * `identifyUser(email)` must keep using the email as the distinct ID to match
 * the web convention (see apps/web PostHogProvider) — otherwise the same
 * person double-counts across platforms.
 *
 * Payload rules (hard): stable enum strings only — no free text, no PII. This
 * binds OUR `captureEvent` / `customAppProperties` payloads. The
 * `mobile_list_diagnostics` event obeys the same rule — counts, booleans, and
 * enum strings only; no URL, no search text, no error message, no PII. The
 * SDK's stock auto-captured device fields (`$device_name`, `$device_manufacturer`,
 * etc.) are an intentional exception — still no PII beyond stock device metadata.
 *
 * Auto-captured on every event (posthog-react-native 4.59.0 `native-deps.js`):
 * - Once `expo-device` is installed: `$device_manufacturer`, `$device_name`,
 *   `$os_name`, `$os_version`, `$is_emulator`
 * - Always: `$device_type` (always the string `'Mobile'` — no form-factor
 *   granularity), `$app_name`/`$app_version`/`$app_build`/`$app_namespace`,
 *   `$locale`/`$timezone`, `$screen_width`/`$screen_height`
 *
 * Brand (`Device.brand`) is skipped — near-duplicate of manufacturer, no extra
 * segmentation value. Form factor is the real gap: we add `device_form_factor`
 * via the `customAppProperties` constructor option (merges into `_appProperties`,
 * lands on every event including the first, survives `client.reset()` — unlike
 * `register()`). We do not override the reserved `$device_type`.
 */

export const SESSION_VIEWED_EVENT = 'session_viewed';
export const MESSAGE_SENT_EVENT = 'message_sent';
export const SESSION_CREATED_EVENT = 'session_created';
export const PERMISSION_RESPONDED_EVENT = 'permission_responded';
export const QUESTION_ANSWERED_EVENT = 'question_answered';
export const CONVERSATION_CREATED_EVENT = 'conversation_created';
export const INSTANCE_ACTION_EVENT = 'instance_action';
export const FEEDBACK_SUBMITTED_EVENT = 'feedback_submitted';
// Matches the event name web already captures — keep in sync for shared funnels.
export const ORGANIZATION_MEMBER_INVITED_EVENT = 'organization_member_invited';
export const KILO_PASS_PURCHASE_STARTED_EVENT = 'kilo_pass_purchase_started';
export const KILO_PASS_PURCHASE_COMPLETED_EVENT = 'kilo_pass_purchase_completed';
export const KILO_PASS_PURCHASE_FAILED_EVENT = 'kilo_pass_purchase_failed';
export const APP_STARTUP_EVENT = 'app_startup';
export const LIST_DIAGNOSTICS_EVENT = 'mobile_list_diagnostics';

export type AnalyticsSurface = 'claw' | 'cloud-agent' | 'remote-session';

// PostHog feature flags. The project is shared with web, so mobile-only flags
// are prefixed to avoid colliding with web flag keys.
export const FEATURE_FLAG_PR_REVIEW = 'mobile-pr-review';
export const FEATURE_FLAG_DEEP_DIAGNOSTICS = 'mobile-deep-diagnostics';

let client: PostHog | null = null;

// `useFeatureFlag` subscribers register here rather than on `client`, because
// the client is created lazily (after consent) — a component that mounts before
// init would otherwise subscribe to a null client and never re-render when
// flags later load. init wires the client's single update into this registry.
const flagListeners = new Set<() => void>();

// App version + build for PostHog. Both are strings; `app_build` is a monotonic
// integer-as-string, so it's the reliable field for "release >= N" flag rules
// (`app_version` compares lexicographically). Native SDK auto-captures
// $app_version/$app_build on events; flag targeting needs them as person
// properties, which this supplies.
function appVersionProperties(): Record<string, string> {
  const props: Record<string, string> = {};
  if (Application.nativeApplicationVersion) {
    props.app_version = Application.nativeApplicationVersion;
  }
  if (Application.nativeBuildVersion) {
    props.app_build = Application.nativeBuildVersion;
  }
  return props;
}

// Total mapping of expo-device DeviceType (+ null) → stable enum strings.
// Always present on every event via customAppProperties; never conditional.
function deviceFormFactor(): 'phone' | 'tablet' | 'desktop' | 'tv' | 'unknown' {
  // Total mapping: null / UNKNOWN / unexpected → 'unknown'. if-chain (not
  // switch) so exhaustiveness over DeviceType | null stays lint-clean.
  if (Device.deviceType === Device.DeviceType.PHONE) {
    return 'phone';
  }
  if (Device.deviceType === Device.DeviceType.TABLET) {
    return 'tablet';
  }
  if (Device.deviceType === Device.DeviceType.DESKTOP) {
    return 'desktop';
  }
  if (Device.deviceType === Device.DeviceType.TV) {
    return 'tv';
  }
  return 'unknown';
}

export function initPostHog(): void {
  if (client) {
    return;
  }
  client = new PostHog(POSTHOG_API_KEY, {
    host: 'https://us.i.posthog.com',
    // No events are sent from dev builds.
    disabled: __DEV__,
    customAppProperties: properties => ({
      ...properties,
      device_form_factor: deviceFormFactor(),
    }),
  });
  // Super property on every event so dashboards can filter mobile vs web
  // without relying on $lib.
  void client.register({ platform: 'mobile' });
  // Feed app version/build into flag evaluation so flags can target by release
  // even before (or without) an identified user. Triggers a flag reload.
  client.setPersonPropertiesForFlags(appVersionProperties());
  client.onFeatureFlags(() => {
    for (const listener of flagListeners) {
      listener();
    }
  });
}

export function captureEvent(
  name: string,
  properties?: Record<string, string | number | boolean>
): void {
  client?.capture(name, properties);
}

export function captureScreen(name: string): void {
  void client?.screen(name);
}

export function identifyUser(email: string): void {
  // Persist version/build on the person profile too, so cohorts and insights
  // can segment by release (not just flag targeting).
  client?.identify(email, { email, ...appVersionProperties() });
  // Pull the freshly-identified user's flags so gated UI resolves promptly.
  void client?.reloadFeatureFlags();
}

export function resetAnalyticsUser(): void {
  client?.reset();
}

function subscribeToFlagUpdates(onChange: () => void): () => void {
  flagListeners.add(onChange);
  return () => {
    flagListeners.delete(onChange);
  };
}

function isFeatureEnabled(key: string, defaultValue: boolean): boolean {
  const value = client?.getFeatureFlag(key);
  return value === undefined ? defaultValue : value === true;
}

/**
 * Reactively read a boolean feature flag. Fails open: while the client is
 * disabled (dev builds), uninitialized, or flags have not loaded yet, returns
 * `defaultValue`. Flags only ever flip UI off on an explicit `false`.
 */
export function useFeatureFlag(key: string, defaultValue = false): boolean {
  const subscribe = useCallback(subscribeToFlagUpdates, []);
  const getSnapshot = useCallback(() => isFeatureEnabled(key, defaultValue), [key, defaultValue]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Reactively read a feature flag's JSON payload as a string. The snapshot is
 * serialized because `useSyncExternalStore` compares snapshots with `Object.is`
 * and the SDK returns a new object on every read. Returns `null` when the
 * client is absent (dev builds, no consent) or the flag has no payload.
 */
export function useFeatureFlagPayloadJson(key: string): string | null {
  const subscribe = useCallback(subscribeToFlagUpdates, []);
  const getSnapshot = useCallback(() => {
    // eslint-disable-next-line typescript-eslint/no-deprecated -- silent read avoids $feature_flag_called
    const payload = client?.getFeatureFlagPayload(key);
    return payload === undefined || payload === null ? null : JSON.stringify(payload);
  }, [key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
