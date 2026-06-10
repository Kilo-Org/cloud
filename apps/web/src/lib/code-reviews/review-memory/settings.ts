import * as z from 'zod';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { agent_configs } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';

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
  const config = await getReviewMemoryConfigRow(input);
  return getReviewMemoryEnabledFromConfig(config?.config);
}

export async function setReviewMemoryEnabled(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  enabled: boolean;
  createdBy: string;
}): Promise<boolean> {
  const existing = await getReviewMemoryConfigRow(input);
  const existingConfig = existing?.config;
  const config = {
    ...(existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
      ? existingConfig
      : {}),
    review_memory_enabled: input.enabled,
  };
  const now = new Date().toISOString();

  const updateSet: Partial<typeof agent_configs.$inferInsert> = {
    config,
    updated_at: now,
  };

  if (input.owner.type === 'org') {
    await db
      .insert(agent_configs)
      .values({
        owned_by_organization_id: input.owner.id,
        owned_by_user_id: null,
        agent_type: 'code_review',
        platform: input.platform,
        config,
        is_enabled: false,
        created_by: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [
          agent_configs.owned_by_organization_id,
          agent_configs.agent_type,
          agent_configs.platform,
        ],
        set: updateSet,
      });
  } else {
    await db
      .insert(agent_configs)
      .values({
        owned_by_organization_id: null,
        owned_by_user_id: input.owner.id,
        agent_type: 'code_review',
        platform: input.platform,
        config,
        is_enabled: false,
        created_by: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [agent_configs.owned_by_user_id, agent_configs.agent_type, agent_configs.platform],
        set: updateSet,
      });
  }

  return input.enabled;
}

async function getReviewMemoryConfigRow(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
}) {
  const conditions = [
    eq(agent_configs.agent_type, 'code_review'),
    eq(agent_configs.platform, input.platform),
  ];

  if (input.owner.type === 'org') {
    conditions.push(eq(agent_configs.owned_by_organization_id, input.owner.id));
  } else {
    conditions.push(eq(agent_configs.owned_by_user_id, input.owner.id));
  }

  const [config] = await db
    .select()
    .from(agent_configs)
    .where(and(...conditions))
    .limit(1);
  return config ?? null;
}
