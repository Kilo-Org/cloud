import * as z from 'zod';
import { and, eq, sql } from 'drizzle-orm';

import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { createDefaultCodeReviewConfig } from '@/lib/code-reviews/core/default-config';
import { db } from '@/lib/drizzle';
import { agent_configs } from '@kilocode/db/schema';

export type ReviewAnalyticsOwner = { type: 'org'; id: string };
export type ReviewAnalyticsPlatform = 'github' | 'gitlab';

const ReviewAnalyticsSettingsSchema = z.object({
  review_analytics_enabled: z.boolean().optional(),
});

export function getReviewAnalyticsEnabledFromConfig(config: unknown): boolean {
  const parsed = ReviewAnalyticsSettingsSchema.safeParse(config);
  if (!parsed.success) {
    return false;
  }

  return parsed.data.review_analytics_enabled ?? false;
}

export async function isReviewAnalyticsEnabled(input: {
  owner: ReviewAnalyticsOwner;
  platform: ReviewAnalyticsPlatform;
}): Promise<boolean> {
  const config = await getReviewAnalyticsConfigRow(input);
  return getReviewAnalyticsEnabledFromConfig(config?.config);
}

export async function setReviewAnalyticsEnabled(input: {
  owner: ReviewAnalyticsOwner;
  platform: ReviewAnalyticsPlatform;
  enabled: boolean;
  createdBy: string;
}): Promise<boolean> {
  const config = createDefaultCodeReviewConfig({ reviewAnalyticsEnabled: input.enabled });
  const updatedConfig = sql<CodeReviewAgentConfig | Record<string, unknown>>`jsonb_set(
    CASE
      WHEN jsonb_typeof(${agent_configs.config}) = 'object' THEN ${agent_configs.config}
      ELSE '{}'::jsonb
    END,
    '{review_analytics_enabled}',
    ${JSON.stringify(input.enabled)}::jsonb,
    true
  )`;
  const [saved] = await db
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
      set: {
        config: updatedConfig,
        updated_at: new Date().toISOString(),
      },
    })
    .returning({ config: agent_configs.config });

  if (!saved) {
    throw new Error('Failed to save Code Reviewer analytics setting');
  }

  return getReviewAnalyticsEnabledFromConfig(saved.config);
}

async function getReviewAnalyticsConfigRow(input: {
  owner: ReviewAnalyticsOwner;
  platform: ReviewAnalyticsPlatform;
}) {
  const [config] = await db
    .select()
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, input.platform),
        eq(agent_configs.owned_by_organization_id, input.owner.id)
      )
    )
    .limit(1);

  return config ?? null;
}
