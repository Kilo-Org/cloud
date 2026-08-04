import { byok_api_keys, coding_plan_subscriptions, getWorkerDb } from '@kilocode/db';
import { formatError } from '@kilocode/worker-utils';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import * as z from 'zod';
import { hashIdentifierForTelemetry } from './conversation-identity';
import { kvReadThrough } from './kv-read-through';

const CODING_PLAN_PREFERENCE_KEY_PREFIX = 'coding_plan_preference:v2:';
const CODING_PLAN_PREFERENCE_TTL_SECONDS = 60;
const BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID = 'byteplus-coding/bytedance-seed-code';
const MINIMAX_CODING_PLAN_DEFAULT_MODEL_ID = 'minimax/minimax-m3';

const CodingPlanPreferenceSchema = z.union([
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    planId: z.literal('byteplus-coding-plan-team-lite'),
    providerId: z.literal('byteplus-coding'),
    modelId: z.literal(BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID),
  }),
  z.object({
    active: z.literal(true),
    planId: z.literal('minimax-token-plan-plus'),
    providerId: z.literal('minimax'),
    modelId: z.literal(MINIMAX_CODING_PLAN_DEFAULT_MODEL_ID),
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
  const [row] = await db
    .select({
      planId: coding_plan_subscriptions.plan_id,
      providerId: coding_plan_subscriptions.provider_id,
    })
    .from(coding_plan_subscriptions)
    .innerJoin(byok_api_keys, eq(byok_api_keys.id, coding_plan_subscriptions.installed_byok_key_id))
    .where(
      and(
        eq(coding_plan_subscriptions.user_id, userId),
        inArray(coding_plan_subscriptions.status, ['active', 'past_due']),
        eq(byok_api_keys.kilo_user_id, coding_plan_subscriptions.user_id),
        eq(byok_api_keys.provider_id, coding_plan_subscriptions.provider_id),
        eq(byok_api_keys.management_source, 'coding_plan'),
        eq(byok_api_keys.is_enabled, true),
        or(
          and(
            eq(coding_plan_subscriptions.plan_id, 'byteplus-coding-plan-team-lite'),
            eq(coding_plan_subscriptions.provider_id, 'byteplus-coding')
          ),
          and(
            eq(coding_plan_subscriptions.plan_id, 'minimax-token-plan-plus'),
            eq(coding_plan_subscriptions.provider_id, 'minimax')
          )
        )
      )
    )
    .orderBy(
      sql`case
        when ${coding_plan_subscriptions.plan_id} = 'byteplus-coding-plan-team-lite'
          and ${coding_plan_subscriptions.provider_id} = 'byteplus-coding' then 0
        when ${coding_plan_subscriptions.plan_id} = 'minimax-token-plan-plus'
          and ${coding_plan_subscriptions.provider_id} = 'minimax' then 1
        else 2
      end`
    )
    .limit(1);
  if (row?.planId === 'byteplus-coding-plan-team-lite' && row.providerId === 'byteplus-coding') {
    return {
      active: true,
      planId: 'byteplus-coding-plan-team-lite',
      providerId: 'byteplus-coding',
      modelId: BYTEPLUS_CODING_PLAN_DEFAULT_MODEL_ID,
    };
  }
  if (row?.planId === 'minimax-token-plan-plus' && row.providerId === 'minimax') {
    return {
      active: true,
      planId: 'minimax-token-plan-plus',
      providerId: 'minimax',
      modelId: MINIMAX_CODING_PLAN_DEFAULT_MODEL_ID,
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
