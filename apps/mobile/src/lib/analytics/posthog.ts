import PostHog from 'posthog-react-native';

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

let client: PostHog | null = null;

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
}

export function resetAnalyticsUser(): void {
  client?.reset();
}
