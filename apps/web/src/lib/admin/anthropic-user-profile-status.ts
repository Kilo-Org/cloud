import 'server-only';
import { APIError } from '@anthropic-ai/sdk';
import { TRPCError } from '@trpc/server';
import { retrieveAnthropicUserProfile } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';

/** Fetches the stored Anthropic user profile for an admin, as Anthropic returns it. */
export async function pullAnthropicUserProfileStatus(userProfileId: string | null | undefined) {
  if (!userProfileId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No Anthropic user profile linked',
    });
  }
  if (!isClaudeOperatorConfigured()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The Claude operator is not configured',
    });
  }
  try {
    return { profile: await retrieveAnthropicUserProfile(userProfileId) };
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Anthropic user profile ${userProfileId} does not exist`,
        cause: error,
      });
    }
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
}
