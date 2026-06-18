import { getWorkerDb, sql } from '@kilocode/db';
import { formatError } from '@kilocode/worker-utils';
import * as z from 'zod';
import { hashIdentifierForTelemetry } from './conversation-identity';
import { kvReadThrough } from './kv-read-through';

const CODING_PLAN_PREFERENCE_KEY_PREFIX = 'coding_plan_preference:';
const CODING_PLAN_PREFERENCE_TTL_SECONDS = 60;
const CODING_PLAN_DEFAULT_MODEL_ID = 'minimax/minimax-m3';

const CodingPlanPreferenceSchema = z.discriminatedUnion('active', [
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    planId: z.literal('minimax-token-plan-plus'),
    providerId: z.literal('minimax'),
    modelId: z.literal(CODING_PLAN_DEFAULT_MODEL_ID),
  }),
]);

export type CodingPlanPreference = z.infer<typeof CodingPlanPreferenceSchema>;

type CodingPlanPreferenceEnv = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'HYPERDRIVE'>;

export function codingPlanDefaultDecision(
  preference: Extract<CodingPlanPreference, { active: true }>
) {
  return {
    model: preference.modelId,
    taskType: null,
    subtaskType: null,
    source: 'coding_plan_default' as const,
    tableVersion: 'coding-plan:v1',
    reasoningEffort: null,
    sticky: false,
  };
}

function parseCodingPlanPreference(raw: string): CodingPlanPreference | null {
  try {
    const parsed = CodingPlanPreferenceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function queryCodingPlanPreference(
  env: CodingPlanPreferenceEnv,
  userId: string
): Promise<CodingPlanPreference> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const { rows } = await db.execute<{
    plan_id: string;
    provider_id: string;
  }>(sql`
    SELECT s.plan_id, s.provider_id
    FROM coding_plan_subscriptions s
    INNER JOIN byok_api_keys k ON k.id = s.installed_byok_key_id
    WHERE s.user_id = ${userId}
      AND s.status IN ('active', 'past_due')
      AND k.kilo_user_id = s.user_id
      AND k.provider_id = s.provider_id
      AND k.management_source = 'coding_plan'
      AND k.is_enabled = true
    LIMIT 1
  `);
  const row = rows[0];
  if (row?.plan_id === 'minimax-token-plan-plus' && row.provider_id === 'minimax') {
    return {
      active: true,
      planId: 'minimax-token-plan-plus',
      providerId: 'minimax',
      modelId: CODING_PLAN_DEFAULT_MODEL_ID,
    };
  }
  return { active: false };
}

export async function getCodingPlanPreference(
  env: CodingPlanPreferenceEnv,
  userId: string
): Promise<CodingPlanPreference> {
  if (userId.startsWith('anon:')) {
    return { active: false };
  }

  const userIdHash = await hashIdentifierForTelemetry(userId);
  const key = `${CODING_PLAN_PREFERENCE_KEY_PREFIX}${userIdHash}`;
  try {
    return (
      (await kvReadThrough({
        kv: env.AUTO_ROUTING_CONFIG,
        key,
        ttlSeconds: CODING_PLAN_PREFERENCE_TTL_SECONDS,
        fetchOrigin: () => queryCodingPlanPreference(env, userId),
        parse: parseCodingPlanPreference,
      })) ?? { active: false }
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'coding_plan_preference_read_failed',
        key,
        ...formatError(error),
      })
    );
    return { active: false };
  }
}
