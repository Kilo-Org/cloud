import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import * as z from 'zod';

import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { DEFAULT_CODE_REVIEW_MODEL } from '@/lib/code-reviews/core/constants';
import { APP_URL } from '@/lib/constants';
import { FEATURE_HEADER } from '@/lib/feature-detection';
import { generateApiToken } from '@/lib/tokens';
import { findUserById } from '@/lib/user';
import type { User } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';

const ReviewMemoryModelConfigSchema = z.object({
  model_slug: z.string().optional(),
});

export async function resolveReviewMemoryActor(owner: ReviewMemoryOwner): Promise<User> {
  if (owner.type === 'org') {
    return await ensureBotUserForOrg(owner.id, 'code-review');
  }

  const user = await findUserById(owner.id);
  if (!user) throw new Error('Review Memory owner user not found');
  return user;
}

export async function resolveReviewMemoryModel(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
}): Promise<{ modelSlug: string }> {
  const agentConfig = await getAgentConfigForOwner(input.owner, 'code_review', input.platform);
  const parsed = ReviewMemoryModelConfigSchema.safeParse(agentConfig?.config);
  if (!parsed.success) {
    return { modelSlug: DEFAULT_CODE_REVIEW_MODEL };
  }

  return { modelSlug: parsed.data.model_slug || DEFAULT_CODE_REVIEW_MODEL };
}

export function createReviewMemoryGatewayProvider(input: {
  owner: ReviewMemoryOwner;
  actor: User;
  userAgent: string;
}) {
  const headers: Record<string, string> = {
    'User-Agent': input.userAgent,
    [FEATURE_HEADER]: 'code-review-memory',
  };
  if (input.owner.type === 'org') {
    headers['X-KiloCode-OrganizationId'] = input.owner.id;
  }

  return createOpenAICompatible({
    name: 'kilo-gateway',
    baseURL: `${APP_URL}/api/openrouter`,
    apiKey: generateApiToken(input.actor, { internalApiUse: true }),
    headers,
  });
}

export function extractReviewMemoryJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return JSON.parse(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('Review Memory model did not return JSON');
}
