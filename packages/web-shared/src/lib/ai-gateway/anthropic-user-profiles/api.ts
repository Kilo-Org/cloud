import 'server-only';
import { createHmac } from 'node:crypto';
import { NotFoundError } from '@anthropic-ai/sdk';
import type {
  UserProfile,
  UserProfileCreateParams,
} from '@anthropic-ai/sdk/resources/user-profiles/user-profiles';
import { getClaudeOperatorClient } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';

/**
 * Marks profiles this feature creates, so the cleanup never touches the Claude
 * billing profiles that live in the same Anthropic organization.
 */
export const ANTHROPIC_USER_PROFILE_SOURCE_KEY = 'kilo_source';
export const ANTHROPIC_USER_PROFILE_SOURCE = 'ai_gateway';

export function isGatewayAnthropicUserProfile(profile: UserProfile): boolean {
  return (
    profile.access_type === 'passthrough' &&
    profile.metadata[ANTHROPIC_USER_PROFILE_SOURCE_KEY] === ANTHROPIC_USER_PROFILE_SOURCE
  );
}

export type AnthropicUserProfileDetails =
  | {
      kind: 'user';
      userId: string;
      email: string;
      createdAt: string;
      /** The IP country of the request that created the profile, a best guess at the user's. */
      country: string | null;
    }
  | {
      kind: 'organization';
      organizationId: string;
      name: string;
      createdAt: string;
    };

/**
 * Anthropic only matches hashes computed with the same pepper, so it must never
 * change once profiles carry it.
 */
const EMAIL_HASH_PEPPER = 'kilo-anthropic-user-profile-702b0503d7b03c50efb2fe8d4bc5a2df';

export function anthropicUserProfileEmailHash(email: string): string {
  return createHmac('sha256', EMAIL_HASH_PEPPER).update(email.trim().toLowerCase()).digest('hex');
}

export function anthropicUserProfileCreateParams(
  details: AnthropicUserProfileDetails
): UserProfileCreateParams {
  const metadata = {
    [ANTHROPIC_USER_PROFILE_SOURCE_KEY]: ANTHROPIC_USER_PROFILE_SOURCE,
    kilo_entity: details.kind,
  };
  const onboarded_at = new Date(details.createdAt).toISOString();
  if (details.kind === 'user') {
    return {
      access_type: 'passthrough',
      metadata,
      external_user_details: {
        reference_id: details.userId,
        entity_type: 'individual',
        account_status: 'active',
        onboarded_at,
        email_hash: anthropicUserProfileEmailHash(details.email),
        // Anthropic accepts only an ISO 3166-1 alpha-2 code and cannot clear one later.
        ...(details.country && /^[A-Z]{2}$/.test(details.country)
          ? { country: details.country }
          : {}),
      },
    };
  }
  return {
    access_type: 'passthrough',
    name: details.name,
    metadata,
    external_user_details: {
      reference_id: details.organizationId,
      entity_type: 'business',
      account_status: 'active',
      onboarded_at,
    },
  };
}

// Each create call makes a new profile; the operator client never retries it.
export async function createAnthropicUserProfile(
  details: AnthropicUserProfileDetails
): Promise<string> {
  const profile = await getClaudeOperatorClient().userProfiles.create(
    anthropicUserProfileCreateParams(details)
  );
  return profile.id;
}

export async function retrieveAnthropicUserProfile(userProfileId: string): Promise<UserProfile> {
  return await getClaudeOperatorClient().userProfiles.retrieve(userProfileId, null, {
    maxRetries: 2,
  });
}

export async function renameAnthropicUserProfile(
  userProfileId: string,
  name: string
): Promise<void> {
  await getClaudeOperatorClient().userProfiles.update(userProfileId, { name }, { maxRetries: 2 });
}

/** Deletes a profile; a profile that is already gone counts as deleted. */
export async function deleteAnthropicUserProfile(userProfileId: string): Promise<void> {
  try {
    await getClaudeOperatorClient().userProfiles.delete(userProfileId, null, { maxRetries: 2 });
  } catch (error) {
    if (error instanceof NotFoundError) return;
    throw error;
  }
}

export type AnthropicUserProfilePage = { profiles: UserProfile[]; nextPage: string | null };

/** One page of the profile list, oldest first, so a scan can resume from `nextPage`. */
export async function listAnthropicUserProfilesPage(
  page: string | null
): Promise<AnthropicUserProfilePage> {
  const result = await getClaudeOperatorClient().userProfiles.list(
    { order: 'asc', order_by: 'created_at', limit: 100, page },
    { maxRetries: 2 }
  );
  return { profiles: result.data, nextPage: result.next_page };
}
