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
}

export function captureEvent(name: string, properties: { surface: AnalyticsSurface }): void {
  client?.capture(name, properties);
}

export function identifyUser(email: string): void {
  client?.identify(email, { email });
}

export function resetAnalyticsUser(): void {
  client?.reset();
}
