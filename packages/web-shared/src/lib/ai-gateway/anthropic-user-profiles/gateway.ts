import { eq } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { CLAUDE_BILLING_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/claude-model';
import type { ProviderRoute } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import {
  decideAnthropicUserProfile,
  type AnthropicUserProfileSubject,
} from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/decision';
import { getRuntimeAnthropicUserProfilesSettings } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/settings';

export const ANTHROPIC_USER_PROFILE_HEADER = 'anthropic-user-profile-id';

export type GatewayAnthropicUserProfile = {
  /** The subject's stored profile, sent on Kilo-paid Claude requests. */
  userProfileId: string | null;
  subject: AnthropicUserProfileSubject;
  /** Whether to create a profile for the subject when it has none. */
  create: boolean;
};

/**
 * Whether the route is paid by Kilo. BYOK keys, Claude billing and ChatGPT
 * subscriptions are the customer's own accounts and never carry Kilo's profile.
 */
export function isAnthropicUserProfileRoute(route: Pick<ProviderRoute, 'provider' | 'userByok'>) {
  return (
    route.userByok === null &&
    route.provider.type !== CLAUDE_BILLING_PROVIDER_ID &&
    route.provider.type !== OPENAI_CHATGPT_PROVIDER_ID
  );
}

/** Reads the request's profile settings and stored profile, through the replica. */
export async function resolveGatewayAnthropicUserProfile(params: {
  model: string;
  user: Pick<User, 'id' | 'anthropic_user_profile_id'>;
  organizationId: string | undefined;
}): Promise<GatewayAnthropicUserProfile | null> {
  if (!isClaudeModel(params.model)) return null;
  const settings = await getRuntimeAnthropicUserProfilesSettings();
  if (!settings.enabled) return null;

  let subject: AnthropicUserProfileSubject;
  let userProfileId: string | null;
  if (params.organizationId) {
    const [organization] = await readDb
      .select({
        profileId: organizations.anthropic_user_profile_id,
        parentOrganizationId: organizations.parent_organization_id,
      })
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1);
    if (!organization) return null;
    subject = {
      kind: 'organization',
      organizationId: params.organizationId,
      rootOrganizationId: organization.parentOrganizationId ?? params.organizationId,
    };
    userProfileId = organization.profileId;
  } else {
    subject = { kind: 'user', userId: params.user.id };
    userProfileId = params.user.anthropic_user_profile_id;
  }

  const decision = decideAnthropicUserProfile(settings, subject, Date.now());
  if (!decision.attribute) return null;
  return { userProfileId, subject, create: decision.create };
}
