import {
  type ANALYTICS_SURFACES,
  type AnalyticsEventMap,
  redactProhibitedProperties,
} from '@kilocode/app-shared/analytics';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import PostHog, { PostHogPersistedProperty } from 'posthog-react-native';
import { useCallback, useSyncExternalStore } from 'react';

import { POSTHOG_API_KEY } from '@/lib/config';
import { allowsOptional, currentGeneration } from '@/lib/telemetry/controller';
import {
  posthogCustomStorage,
  purgePostHogPersistence,
  sealPostHogStorage,
  unsealPostHogStorage,
} from '@/lib/telemetry/posthog-storage';

/**
 * Product analytics events. Same PostHog project as the web app, so
 * `identifyUser(email)` must keep using the email as the distinct ID to match
 * the web convention (see apps/web PostHogProvider) — otherwise the same
 * person double-counts across platforms.
 *
 * Payload rules (hard): stable enum strings only — no free text, no PII. This
 * binds OUR `captureEvent` / `customAppProperties` payloads. The SDK's stock
 * auto-captured device fields (`$device_name`, `$device_manufacturer`, etc.)
 * are an intentional exception — still no PII beyond stock device metadata.
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

// Event names come from the shared analytics contract (P1-A-07a / DEC-05) and
// are re-exported here so existing `@/lib/analytics/posthog` imports keep
// working unchanged.
export {
  APP_STARTUP_EVENT,
  CONVERSATION_CREATED_EVENT,
  FEEDBACK_SUBMITTED_EVENT,
  INSTANCE_ACTION_EVENT,
  KILO_PASS_PURCHASE_COMPLETED_EVENT,
  KILO_PASS_PURCHASE_FAILED_EVENT,
  KILO_PASS_PURCHASE_STARTED_EVENT,
  MESSAGE_SENT_EVENT,
  ORGANIZATION_MEMBER_INVITED_EVENT,
  PERMISSION_RESPONDED_EVENT,
  QUESTION_ANSWERED_EVENT,
  SESSION_CREATED_EVENT,
  SESSION_VIEWED_EVENT,
} from '@kilocode/app-shared/analytics';

/** Legacy mobile surface values (existing payloads, unchanged). */
export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];

// PostHog feature flags. The project is shared with web, so mobile-only flags
// are prefixed to avoid colliding with web flag keys.
export const FEATURE_FLAG_PR_REVIEW = 'mobile-pr-review';

let client: PostHog | null = null;
/** Generation that created the client. Stale events from a prior account
 *  are dropped — they must not transmit under the new identity. */
let clientGeneration: number | null = null;

// `useFeatureFlag` subscribers register here rather than on `client`, because
// the client is created lazily (after consent) — a component that mounts before
// init would otherwise subscribe to a null client and never re-render when
// flags later load. init wires the client's single update into this registry.
const flagListeners = new Set<() => void>();

// Subscriber registry so layout-drain can re-trigger once the client is
// created or cleared.  `initPostHog` and `discardPostHog` fire these
// after the client reference changes.
const readyListeners = new Set<() => void>();

// Track every discard completion so resumePostHog can await all prior
// work.  Each discard appends to this chain; resumePostHog captures the
// tail at call time.  Discards that begin after resume are not waited on.
// oxlint-disable-next-line promise/prefer-await-to-then -- seed value
let discardChain: Promise<void> = Promise.resolve();

/** True when `initPostHog` has created the client.  Layout-drain uses
 *  this to defer `takeStartupTimings` until capture can succeed. */
export function isPostHogReady(): boolean {
  return client !== null;
}

/** Register a listener that fires when the client becomes ready (after
 *  `initPostHog`) or not ready (after `discardPostHog`). */
export function subscribeToPostHogReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

function notifyPostHogReady(): void {
  for (const listener of readyListeners) {
    listener();
  }
}

/** Serialize a discard after the chain tail.  Always continues the chain
 *  even when the prior step rejects, so one failed optOut cannot break
 *  later discards or recovery. */
async function chainDiscard(prev: Promise<void>, next: Promise<void>): Promise<void> {
  try {
    await prev;
  } catch {
    // previous discard failed — continue the chain.
  }
  await next;
}

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

/**
 * Allowed person properties and event super properties (hard). Custom fields:
 * `platform`, `device_form_factor`, `app_version`, `app_build`. SDK stock
 * auto-captured fields: `$device_manufacturer`, `$device_name`, `$os_name`,
 * `$os_version`, `$is_emulator`, `$device_type`, `$app_name`, `$app_version`,
 * `$app_build`, `$app_namespace`, `$locale`, `$timezone`, `$screen_width`,
 * `$screen_height`. Anything outside this list needs a DEC-02 amendment.
 */
export function initPostHog(): void {
  if (!allowsOptional()) {
    return;
  }
  if (client) {
    return;
  }
  client = new PostHog(POSTHOG_API_KEY, {
    host: 'https://us.i.posthog.com',
    disableGeoip: true,
    // No events are sent from dev builds.
    disabled: __DEV__,
    customAppProperties: properties => ({
      ...properties,
      device_form_factor: deviceFormFactor(),
    }),
    customStorage: posthogCustomStorage,
  });
  clientGeneration = currentGeneration();
  notifyPostHogReady();
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

export function captureEvent<K extends keyof AnalyticsEventMap>(
  name: K,
  properties?: AnalyticsEventMap[K]
): void;
// Fallback for legacy and test-only callers that pass a literal name outside
// the catalog. The `Exclude` keeps this overload from masking a mistyped
// payload on a cataloged event: when `name` is a map key, `name` is `never`
// here, so only the typed overload above can match.
export function captureEvent<Name extends string>(
  name: Exclude<Name, keyof AnalyticsEventMap>,
  properties?: Record<string, string | number | boolean>
): void;
export function captureEvent(
  name: string,
  properties?: Record<string, string | number | boolean>
): void {
  if (!allowsOptional() || currentGeneration() !== clientGeneration) {
    return;
  }
  // Redaction is a no-op for the cataloged strict-object payloads (their keys
  // are deny-list-safe by schema); it guards the record-shaped `app_startup`
  // payload and every uncataloged dynamic payload at runtime.
  const safe = properties === undefined ? undefined : redactProhibitedProperties(properties);
  client?.capture(name, safe);
}

export function captureScreen(name: string): void {
  if (!allowsOptional() || currentGeneration() !== clientGeneration) {
    return;
  }
  void client?.screen(name);
}

export function identifyUser(email: string): void {
  if (!allowsOptional() || currentGeneration() !== clientGeneration) {
    return;
  }
  // Persist version/build on the person profile too, so cohorts and insights
  // can segment by release (not just flag targeting). No email or name — the
  // allowed-field list above this function governs person properties.
  client?.identify(email, appVersionProperties());
  // Pull the freshly-identified user's flags so gated UI resolves promptly.
  void client?.reloadFeatureFlags();
}

export function resetAnalyticsUser(): void {
  client?.reset();
}

/**
 * Discard all pending events and tear down the SDK. Never calls `shutdown()`
 * or `flush()` — both drain queues, and the purpose of this discard is to drop
 * them unread. The sequence:
 *
 * 1. `sealPostHogStorage()` — sync, first. No debounced persist from the
 *    old client can recreate files after the purge.
 * 2. Clear all three queues (`Queue`, `LogsQueue`, `AiQueue`) so a flush
 *    timer that fires after this step has nothing to send.
 * 3. Drop the module-level `client` reference so concurrent code cannot
 *    capture through the stale instance, and a concurrent `initPostHog()`
 *    can create a fresh client.
 * 4. Flag listeners persist — like ready listeners, they must survive the
 *    discard so mounted `useFeatureFlag` subscribers receive updates when
 *    a later `initPostHog` re-creates the client.
 * 5. `optOut` so a relaunch does not resume capture on the stored anonymous
 *    id. The completion is appended to `discardChain` so `resumePostHog()`
 *    can await every prior discard before unsealing storage.
 *

 * EV-01: An HTTP request already in flight when discard begins cannot be
 * recalled. The risk is bounded to one batch.
 */
// oxlint-disable-next-line require-await -- await is inside the IIFE
export async function discardPostHog(): Promise<void> {
  sealPostHogStorage();

  const completion = (async () => {
    const c = client;
    if (typeof c?.setPersistedProperty !== 'function') {
      client = null;
      notifyPostHogReady();
      return;
    }

    c.setPersistedProperty(PostHogPersistedProperty.Queue, null);
    c.setPersistedProperty(PostHogPersistedProperty.LogsQueue, null);
    c.setPersistedProperty(PostHogPersistedProperty.AiQueue, null);

    // Drop the live reference before any async work so concurrent code
    // cannot capture through the stale instance. Flag listeners persist —
    // like ready listeners, they must survive the discard so mounted
    // useFeatureFlag subscribers receive updates when the client is
    // re-created by a later initPostHog.
    // Ready listeners persist — they must observe both the false transition
    // now and a true transition from a later initPostHog.
    client = null;
    notifyPostHogReady();

    try {
      await c.optOut();
    } catch {
      // optOut might reject — drop everything regardless.
    }
  })();

  // Serialize: chain this completion after every prior discard so
  // resumePostHog can await the tail and be certain every discard
  // that began before it has finished.
  // Memory: each discard creates one extra promise. The chain is at most
  // the number of consent transitions in a session, which is bounded.
  discardChain = chainDiscard(discardChain, completion);

  return completion;
}

/**
 * Await every discard that began before this call, then wait for the SDK's
 * 100 ms persistence debounce (`PERSIST_DEBOUNCE_MS` in `dist/storage.js`),
 * then unseal storage so a later `initPostHog()` can persist again.
 * Capturing the chain tail at call time guarantees every pending debounced
 * write from the old client has fired against the sealed sink and been
 * rejected before the new client is allowed to write.
 */
export async function resumePostHog(): Promise<void> {
  // Capture the chain tail so a discard that begins after this call does
  // not delay the upcoming init.
  await discardChain;
  // Wait for the SDK's 100 ms persistence debounce. The sealed sink drops the
  // old client's scheduled write. Purge then removes its stale on-disk queue
  // before a new client can preload it.
  await new Promise<void>(resolve => {
    setTimeout(resolve, 110);
  });
  purgePostHogPersistence();
  unsealPostHogStorage();
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
  const subscribe = useCallback((onChange: () => void) => {
    flagListeners.add(onChange);
    return () => {
      flagListeners.delete(onChange);
    };
  }, []);
  const getSnapshot = useCallback(() => isFeatureEnabled(key, defaultValue), [key, defaultValue]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
