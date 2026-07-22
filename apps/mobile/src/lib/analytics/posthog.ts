import PostHog from 'posthog-react-native';
import { useCallback, useSyncExternalStore } from 'react';

import { POSTHOG_API_KEY } from '@/lib/config';

/**
 * Product analytics events. Same PostHog project as the web app, so
 * `identifyUser(email)` must keep using the email as the distinct ID to match
 * the web convention (see apps/web PostHogProvider) — otherwise the same
 * person double-counts across platforms.
 *
 * Payload rules (hard): stable enum strings only — no free text, no PII.
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

export type AnalyticsSurface = 'claw' | 'cloud-agent' | 'remote-session';

// PostHog feature flags. The project is shared with web, so mobile-only flags
// are prefixed to avoid colliding with web flag keys.
export const FEATURE_FLAG_PR_REVIEW = 'mobile-pr-review';

let client: PostHog | null = null;

// `useFeatureFlag` subscribers register here rather than on `client`, because
// the client is created lazily (after consent) — a component that mounts before
// init would otherwise subscribe to a null client and never re-render when
// flags later load. init wires the client's single update into this registry.
const flagListeners = new Set<() => void>();

export function initPostHog(): void {
  if (client) {
    return;
  }
  client = new PostHog(POSTHOG_API_KEY, {
    host: 'https://us.i.posthog.com',
    // No events are sent from dev builds.
    disabled: __DEV__,
  });
  // Super property on every event so dashboards can filter mobile vs web
  // without relying on $lib.
  void client.register({ platform: 'mobile' });
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
  client?.identify(email, { email });
  // Pull the freshly-identified user's flags so gated UI resolves promptly.
  void client?.reloadFeatureFlags();
}

export function resetAnalyticsUser(): void {
  client?.reset();
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
