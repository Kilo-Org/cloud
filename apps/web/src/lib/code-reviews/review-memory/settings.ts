import * as z from 'zod';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { agent_configs } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';
import {
  agentConfigConflictTarget,
  agentConfigOwnerValues,
  assertAgentConfigCanBeEnabled,
  configForAtomicMerge,
  getAgentConfigForOwner,
} from '@/lib/agent-config/db/agent-configs';

const ReviewMemorySettingsSchema = z.object({
  review_memory_enabled: z.boolean().optional(),
});

export function getReviewMemoryEnabledFromConfig(config: unknown): boolean {
  const parsed = ReviewMemorySettingsSchema.safeParse(config);
  if (!parsed.success) return false;
  return parsed.data.review_memory_enabled ?? false;
}

export async function isReviewMemoryEnabled(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
}): Promise<boolean> {
  const row = await getAgentConfigForOwner(input.owner, 'code_review', input.platform);
  return getReviewMemoryEnabledFromConfig(row?.config);
}

/**
 * Toggles the review-memory flag. The conflict branch merges only
 * `review_memory_enabled` into the stored config, so a key another writer saved
 * stays intact, and it never touches `is_enabled`.
 */
export async function setReviewMemoryEnabled(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  enabled: boolean;
  createdBy: string;
}): Promise<boolean> {
  const now = new Date().toISOString();

  await db.transaction(async tx => {
    await assertAgentConfigCanBeEnabled({
      owner: input.owner,
      platform: input.platform,
      enabled: input.enabled,
      executor: tx,
    });
    // Review memory owns only its own flag: a new row starts disabled, and an
    // existing row keeps its is_enabled.
    await tx
      .insert(agent_configs)
      .values({
        ...agentConfigOwnerValues(input.owner),
        agent_type: 'code_review',
        platform: input.platform,
        config: { review_memory_enabled: input.enabled },
        is_enabled: false,
        created_by: input.createdBy,
      })
      .onConflictDoUpdate({
        target: agentConfigConflictTarget(input.owner),
        set: {
          config: configForAtomicMerge({ review_memory_enabled: input.enabled }),
          updated_at: now,
        },
      });
  });

  return input.enabled;
}
