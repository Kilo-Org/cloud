import 'server-only';

import PostHogClient from '@/lib/posthog';

import type { OrganizationRole } from './organization-types';

const posthogClient = PostHogClient();

/**
 * Best-effort server-side PostHog capture for a joined organization member.
 * `distinctId` must be the accepting user's `google_user_email` (the web
 * PostHog person key). Properties carry `role` only — never userId or email.
 */
export function captureOrganizationMemberJoined(distinctId: string, role: OrganizationRole): void {
  try {
    posthogClient.capture({
      distinctId,
      event: 'organization_member_joined',
      properties: { role },
    });
  } catch {
    // Best-effort: an analytics failure must never fail accept-invite.
  }
}
