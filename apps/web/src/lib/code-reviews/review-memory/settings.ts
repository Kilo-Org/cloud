import * as z from 'zod';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { agent_configs } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';
import {
  agentConfigConflictTarget,
  agentConfigOwnerValues,
  assertAgentConfigCanBeEnabled,
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

export async function setReviewMemoryEnabled(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  enabled: boolean;
  createdBy: string;
}): Promise<boolean> {
  const existing = await getAgentConfigForOwner(input.owner, 'code_review', input.platform);
  const existingConfig = existing?.config;
  const config = {
    ...(existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
      ? existingConfig
      : {}),
    review_memory_enabled: input.enabled,
  };
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
        config,
        is_enabled: false,
        created_by: input.createdBy,
      })
      .onConflictDoUpdate({
        target: agentConfigConflictTarget(input.owner),
        set: { config, updated_at: now },
      });
  });

  return input.enabled;
}
