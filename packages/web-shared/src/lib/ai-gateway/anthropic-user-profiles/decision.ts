import type { AnthropicUserProfilesSettings } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

/**
 * Whom a request's Anthropic user profile identifies. Organization traffic uses
 * the organization's profile, which a sub-organization shares with its parent
 * (`rootOrganizationId`); personal traffic uses the user's own.
 */
export type AnthropicUserProfileSubject =
  | { kind: 'user'; userId: string }
  | { kind: 'organization'; organizationId: string; rootOrganizationId: string };

export type AnthropicUserProfileDecision = {
  /** Send the subject's existing profile, if it has one. */
  attribute: boolean;
  /** Create a profile when the subject has none yet. */
  create: boolean;
};

const NONE: AnthropicUserProfileDecision = { attribute: false, create: false };

export function decideAnthropicUserProfile(
  settings: AnthropicUserProfilesSettings,
  subject: AnthropicUserProfileSubject,
  nowMs: number
): AnthropicUserProfileDecision {
  if (!settings.enabled) return NONE;
  const [ids, optedIn, optedOut] =
    subject.kind === 'user'
      ? [[subject.userId], settings.opted_in_user_ids, settings.opted_out_user_ids]
      : [
          [subject.organizationId.toLowerCase(), subject.rootOrganizationId.toLowerCase()],
          settings.opted_in_organization_ids,
          settings.opted_out_organization_ids,
        ];
  // An opt-out wins over an opt-in for the same subject.
  if (ids.some(id => optedOut.includes(id))) return NONE;
  const started = settings.start_at !== null && Date.parse(settings.start_at) <= nowMs;
  return { attribute: true, create: started || ids.some(id => optedIn.includes(id)) };
}
