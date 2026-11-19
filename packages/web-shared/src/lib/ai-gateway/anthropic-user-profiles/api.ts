import 'server-only';
import { createHmac } from 'node:crypto';
import { NotFoundError } from '@anthropic-ai/sdk';
import type {
  UserProfile,
  UserProfileCreateParams,
} from '@anthropic-ai/sdk/resources/user-profiles/user-profiles';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
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
    }
  | {
      kind: 'organization';
      organizationId: string;
      name: string;
      createdAt: string;
    };

/**
 * Keyed with a secret pepper, so Anthropic can match profiles that share an
 * email address without being able to recover the address from a guess.
 */
export function anthropicUserProfileEmailHash(email: string, pepper: string): string {
  return createHmac('sha256', pepper).update(email.trim().toLowerCase()).digest('hex');
}

export function anthropicUserProfileCreateParams(
  details: AnthropicUserProfileDetails,
  hashPepper: string | null = getEnvVariable('ANTHROPIC_USER_PROFILE_HASH_PEPPER') || null
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
        // Without the pepper, send no hash rather than an unkeyed one.
        ...(hashPepper
          ? { email_hash: anthropicUserProfileEmailHash(details.email, hashPepper) }
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

export async function* listAnthropicUserProfiles(): AsyncGenerator<UserProfile> {
  yield* getClaudeOperatorClient().userProfiles.list({ limit: 100 }, { maxRetries: 2 });
}
